'use strict';

const { assert, hash } = require('./protocol');

const MIGRATIONS = [
  ['001_advice', `
    CREATE TABLE IF NOT EXISTS advice_votes (
      share_id TEXT NOT NULL, guest_id TEXT NOT NULL, place_key TEXT NOT NULL,
      value INTEGER NOT NULL CHECK (value IN (-1, 0, 1)), version INTEGER NOT NULL CHECK (version > 0),
      updated_at INTEGER NOT NULL, PRIMARY KEY (share_id, guest_id, place_key)
    );
    CREATE INDEX IF NOT EXISTS advice_votes_share_place ON advice_votes (share_id, place_key);
    CREATE TABLE IF NOT EXISTS advice_comments (
      id TEXT PRIMARY KEY, share_id TEXT NOT NULL, guest_id TEXT NOT NULL,
      display_name TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS advice_comments_share_created ON advice_comments (share_id, created_at, id);
    CREATE TABLE IF NOT EXISTS advice_suggestions (
      id TEXT PRIMARY KEY, share_id TEXT NOT NULL, guest_id TEXT NOT NULL,
      google_place_id TEXT NOT NULL, city_id TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('see', 'eat')),
      title TEXT, locality TEXT, country_code TEXT, reason TEXT, display_name TEXT,
      provider_detail_expires_at INTEGER, state TEXT NOT NULL CHECK (state IN ('pending', 'accepting', 'accepted', 'rejected', 'withdrawn')),
      reviewed_payload_json TEXT, reviewed_payload_hash TEXT, accepted_place_id INTEGER,
      reviewed_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS advice_suggestions_share_state ON advice_suggestions (share_id, state, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS advice_suggestions_active_google
      ON advice_suggestions (share_id, google_place_id) WHERE state IN ('pending', 'accepting');
    CREATE TABLE IF NOT EXISTS advice_requests (
      share_id TEXT NOT NULL, guest_id TEXT NOT NULL, request_id TEXT NOT NULL,
      operation TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (share_id, guest_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS advice_requests_created ON advice_requests (created_at);
    CREATE TABLE IF NOT EXISTS advice_revisions (
      share_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision >= 0), updated_at INTEGER NOT NULL
    );
  `],
  ['002_accept_import_result', 'ALTER TABLE advice_suggestions ADD COLUMN accepted_import_json TEXT;'],
  ['003_suggestion_day', `ALTER TABLE advice_suggestions ADD COLUMN day_key TEXT;
    ALTER TABLE advice_suggestions ADD COLUMN edit_version INTEGER NOT NULL DEFAULT 0;`],
  ['004_comment_anchor', 'ALTER TABLE advice_comments ADD COLUMN anchor_json TEXT;']
];

function rows(result, index) { return result?.results?.[index]?.rows || []; }
function json(value) { return JSON.stringify(value); }

class AdviceStore {
  constructor(now = () => Date.now()) { this.now = now; this.presentations = new Map(); }

  rememberPresentation(shareId, guestId, id, presentation) {
    for (const [key, value] of this.presentations) if (value.expiresAt <= this.now()) this.presentations.delete(key);
    if (this.presentations.size >= 200) this.presentations.delete(this.presentations.keys().next().value);
    this.presentations.set(`${shareId}/${id}`, { shareId, guestId, presentation, expiresAt: this.now() + 10 * 60 * 1000 });
  }

  presentation(shareId, guestId, id) {
    const value = this.presentations.get(`${shareId}/${id}`);
    if (!value || value.guestId !== guestId) return {};
    if (value.expiresAt <= this.now()) { this.presentations.delete(`${shareId}/${id}`); return {}; }
    return value.presentation;
  }

  forgetPresentations(shareId, guestId) {
    for (const [key, value] of this.presentations) if (value.shareId === shareId && (guestId === undefined || value.guestId === guestId)) this.presentations.delete(key);
  }

  async migrate(ctx) {
    for (const [id, sql] of MIGRATIONS) await ctx.db.migrate(id, sql);
  }

  async ensureRevision(ctx, shareId) {
    await ctx.db.exec(
      'INSERT OR IGNORE INTO advice_revisions (share_id, revision, updated_at) VALUES (?, 0, ?)',
      shareId, this.now()
    );
  }

  async revision(ctx, shareId) {
    const found = await ctx.db.query('SELECT revision FROM advice_revisions WHERE share_id = ?', shareId);
    return found.length ? Number(found[0].revision) : 0;
  }

  async request(ctx, shareId, guestId, requestId) {
    const found = await ctx.db.query(
      'SELECT operation, payload_hash, result_json FROM advice_requests WHERE share_id = ? AND guest_id = ? AND request_id = ?',
      shareId, guestId, requestId
    );
    if (!found.length) return null;
    return { ...found[0], result: JSON.parse(found[0].result_json) };
  }

  async votes(ctx, shareId) {
    return ctx.db.query(
      'SELECT place_key, guest_id, value, version FROM advice_votes WHERE share_id = ?', shareId
    );
  }

  async applyVote(ctx, input) {
    await this.ensureRevision(ctx, input.shareId);
    const stamp = this.now();
    const result = await ctx.db.tx([
      {
        sql: `INSERT INTO advice_votes (share_id, guest_id, place_key, value, version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (share_id, guest_id, place_key) DO UPDATE SET
            value = excluded.value, version = advice_votes.version + 1, updated_at = excluded.updated_at
          WHERE advice_votes.version = ?
          RETURNING place_key`,
        args: [input.shareId, input.guestId, input.placeKey, input.value, input.expectedVersion + 1, stamp, input.expectedVersion]
      },
      {
        sql: 'UPDATE advice_revisions SET revision = revision + 1, updated_at = ? WHERE share_id = ? AND changes() = 1',
        args: [stamp, input.shareId]
      },
      {
        sql: `INSERT INTO advice_requests (share_id, guest_id, request_id, operation, payload_hash, result_json, created_at)
          SELECT ?, ?, ?, 'vote.set', ?, json_object(
            'version', 1, 'kind', 'vote.set', 'data', json_object(
              'placeKey', v.place_key, 'value', v.value, 'version', v.version,
              'positive', (SELECT count(*) FROM advice_votes p WHERE p.share_id = v.share_id AND p.place_key = v.place_key AND p.value = 1),
              'negative', (SELECT count(*) FROM advice_votes n WHERE n.share_id = v.share_id AND n.place_key = v.place_key AND n.value = -1),
              'mine', v.value
            ), 'vote', json_object(
              'placeKey', v.place_key, 'value', v.value, 'version', v.version,
              'positive', (SELECT count(*) FROM advice_votes p WHERE p.share_id = v.share_id AND p.place_key = v.place_key AND p.value = 1),
              'negative', (SELECT count(*) FROM advice_votes n WHERE n.share_id = v.share_id AND n.place_key = v.place_key AND n.value = -1),
              'mine', v.value
            )
          ), ?
          FROM advice_votes v WHERE v.share_id = ? AND v.guest_id = ? AND v.place_key = ? AND changes() = 1`,
        args: [input.shareId, input.guestId, input.requestId, input.payloadHash, stamp, input.shareId, input.guestId, input.placeKey]
      }
    ]);
    return { applied: rows(result, 0).length > 0, request: await this.request(ctx, input.shareId, input.guestId, input.requestId) };
  }

  async createComment(ctx, input) {
    await this.ensureRevision(ctx, input.shareId);
    const stamp = this.now();
    const result = await ctx.db.tx([
      {
        sql: `INSERT OR IGNORE INTO advice_comments (id, share_id, guest_id, display_name, body, created_at, anchor_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [input.commentId, input.shareId, input.guestId, input.displayName || null, input.body, stamp, input.anchor ? json(input.anchor) : null]
      },
      {
        sql: 'UPDATE advice_revisions SET revision = revision + 1, updated_at = ? WHERE share_id = ? AND changes() = 1',
        args: [stamp, input.shareId]
      },
      {
        sql: `INSERT OR IGNORE INTO advice_requests (share_id, guest_id, request_id, operation, payload_hash, result_json, created_at)
          SELECT ?, ?, ?, 'comment.create', ?, ?, ? WHERE changes() = 1`,
        args: [input.shareId, input.guestId, input.requestId, input.payloadHash, json({
          version: 1, kind: 'comment.create', data: { commentId: input.commentId, body: input.body, displayName: input.displayName || null }
        }), stamp]
      }
    ]);
    return { applied: Number(result?.results?.[0]?.changes || 0) === 1, request: await this.request(ctx, input.shareId, input.guestId, input.requestId) };
  }

  async comments(ctx, shareId, guestId, owner = false, limit = 50, after = null) {
    const scope = owner ? 'share_id = ?' : 'share_id = ? AND guest_id = ?';
    const cursor = after ? ' AND (created_at > ? OR (created_at = ? AND id > ?))' : '';
    const sql = `SELECT id, guest_id, display_name, body, created_at, deleted_at, anchor_json FROM advice_comments
      WHERE ${scope} AND deleted_at IS NULL${cursor} ORDER BY created_at, id LIMIT ?`;
    const args = owner ? [shareId] : [shareId, guestId];
    if (after) args.push(after.createdAt, after.createdAt, after.id);
    args.push(limit);
    return ctx.db.query(sql, ...args);
  }

  async createSuggestion(ctx, input) {
    await this.ensureRevision(ctx, input.shareId);
    const stamp = this.now();
    const result = await ctx.db.tx([
      {
        sql: `INSERT OR IGNORE INTO advice_suggestions
          (id, share_id, guest_id, google_place_id, city_id, category, title, locality, country_code, reason, display_name,
           provider_detail_expires_at, state, created_at, updated_at, day_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        args: [input.id, input.shareId, input.guestId, input.googlePlaceId, input.cityId, input.category,
          input.title, input.locality, input.countryCode, input.reason || null, input.displayName || null,
          input.providerDetailExpiresAt, stamp, stamp, input.dayKey || null]
      },
      {
        sql: 'UPDATE advice_revisions SET revision = revision + 1, updated_at = ? WHERE share_id = ? AND changes() = 1',
        args: [stamp, input.shareId]
      },
      {
        sql: `INSERT OR IGNORE INTO advice_requests (share_id, guest_id, request_id, operation, payload_hash, result_json, created_at)
          SELECT ?, ?, ?, 'suggestion.create', ?, ?, ? WHERE changes() = 1`,
        args: [input.shareId, input.guestId, input.requestId, input.payloadHash, json({
          version: 1, kind: 'suggestion.create', data: { suggestionId: input.id, state: 'pending', cityId: input.cityId, category: input.category }
        }), stamp]
      }
    ]);
    return { applied: Number(result?.results?.[0]?.changes || 0) === 1, request: await this.request(ctx, input.shareId, input.guestId, input.requestId) };
  }

  async findActiveSuggestion(ctx, shareId, googlePlaceId) {
    const found = await ctx.db.query(
      "SELECT id, state, guest_id, city_id, category FROM advice_suggestions WHERE share_id = ? AND google_place_id = ? AND state IN ('pending', 'accepting') LIMIT 1",
      shareId, googlePlaceId
    );
    return found[0] || null;
  }

  async suggestions(ctx, shareId, guestId, owner = false) {
    const sql = owner
      ? 'SELECT id, guest_id, google_place_id, city_id, category, title, locality, country_code, reason, display_name, provider_detail_expires_at, state, accepted_place_id, reviewed_by, created_at, updated_at, day_key FROM advice_suggestions WHERE share_id = ? ORDER BY created_at, id'
      : "SELECT id, google_place_id, city_id, category, title, locality, country_code, reason, display_name, provider_detail_expires_at, state, accepted_place_id, created_at, day_key FROM advice_suggestions WHERE share_id = ? AND guest_id = ? AND state IN ('pending', 'accepted') ORDER BY created_at, id";
    return owner ? ctx.db.query(sql, shareId) : ctx.db.query(sql, shareId, guestId);
  }

  async suggestion(ctx, shareId, id) {
    const found = await ctx.db.query(
      'SELECT id, share_id, guest_id, google_place_id, city_id, category, title, locality, country_code, reason, display_name, provider_detail_expires_at, state, reviewed_payload_json, reviewed_payload_hash, accepted_place_id, accepted_import_json, reviewed_by, day_key, edit_version FROM advice_suggestions WHERE share_id = ? AND id = ?',
      shareId, id
    );
    return found[0] || null;
  }

  async applyMutationRequest(ctx, input, mutation, resultSql, resultArgs = [], recordNoop = true) {
    await this.ensureRevision(ctx, input.shareId);
    const stamp = this.now();
    const result = await ctx.db.tx([
      { sql: mutation.sql, args: mutation.args },
      {
        sql: recordNoop
          ? `INSERT OR IGNORE INTO advice_requests (share_id, guest_id, request_id, operation, payload_hash, result_json, created_at)
            VALUES (?, ?, ?, ?, ?, ${resultSql}, ?)`
          : `INSERT OR IGNORE INTO advice_requests (share_id, guest_id, request_id, operation, payload_hash, result_json, created_at)
            SELECT ?, ?, ?, ?, ?, ${resultSql}, ? WHERE changes() = 1`,
        args: [input.shareId, input.guestId, input.requestId, input.operation, input.payloadHash, ...resultArgs, stamp]
      }
    ]);
    if (Number(result?.results?.[0]?.changes || 0) === 1) await ctx.db.exec(
      'UPDATE advice_revisions SET revision = revision + 1, updated_at = ? WHERE share_id = ?', this.now(), input.shareId
    );
    return { mutated: Number(result?.results?.[0]?.changes || 0) === 1, request: await this.request(ctx, input.shareId, input.guestId, input.requestId) };
  }

  async withdrawSuggestion(ctx, input) {
    const result = await this.applyMutationRequest(ctx, input, {
      sql: "UPDATE advice_suggestions SET state = 'withdrawn', updated_at = ? WHERE share_id = ? AND id = ? AND guest_id = ? AND state = 'pending'",
      args: [this.now(), input.shareId, input.suggestionId, input.guestId]
    }, "json_object('version', 1, 'kind', 'suggestion.withdraw', 'data', json_object('suggestionId', ?, 'state', 'withdrawn'))", [input.suggestionId], false);
    assert(result.request, 'suggestion is not withdrawable', 409, 'SUGGESTION_STATE_CONFLICT');
    return result.request.result;
  }

  async updateSuggestion(ctx, input) {
    await this.ensureRevision(ctx, input.shareId);
    const stamp = this.now();
    const mutation = {
      sql: `UPDATE advice_suggestions SET google_place_id = ?, city_id = ?, category = ?, title = ?, locality = ?, country_code = ?,
        reason = ?, display_name = ?, day_key = ?, provider_detail_expires_at = ?, updated_at = ?, edit_version = edit_version + 1
        WHERE share_id = ? AND id = ? AND guest_id = ? AND state = 'pending' AND edit_version = ?`,
      args: [input.googlePlaceId, input.cityId, input.category, input.title, input.locality, input.countryCode,
        input.reason || null, input.displayName || null, input.dayKey || null, input.providerDetailExpiresAt,
        stamp, input.shareId, input.suggestionId, input.guestId, input.expectedVersion]
    };
    try {
      await ctx.db.tx([mutation, {
        sql: 'UPDATE advice_revisions SET revision = revision + 1, updated_at = ? WHERE share_id = ? AND changes() = 1',
        args: [stamp, input.shareId]
      }, {
        sql: `INSERT INTO advice_requests (share_id, guest_id, request_id, operation, payload_hash, result_json, created_at)
          SELECT ?, ?, ?, 'suggestion.update', ?, ?, ? WHERE changes() = 1`,
        args: [input.shareId, input.guestId, input.requestId, input.payloadHash,
          json({ version: 1, kind: 'suggestion.update', data: { suggestionId: input.suggestionId, state: 'pending' } }), stamp]
      }]);
    } catch (error) {
      const prior = await this.request(ctx, input.shareId, input.guestId, input.requestId);
      if (!prior || prior.payload_hash !== input.payloadHash) throw error;
      return prior.result;
    }
    const completed = await this.request(ctx, input.shareId, input.guestId, input.requestId);
    assert(completed, 'suggestion is not editable', 409, 'SUGGESTION_STATE_CONFLICT');
    assert(completed.payload_hash === input.payloadHash, 'request ID was already used for another payload', 409, 'REQUEST_REUSE_CONFLICT');
    return completed.result;
  }

  async deleteCommentForGuest(ctx, input) {
    const result = await this.applyMutationRequest(ctx, input, {
      sql: 'UPDATE advice_comments SET deleted_at = ? WHERE share_id = ? AND id = ? AND guest_id = ? AND deleted_at IS NULL',
      args: [this.now(), input.shareId, input.commentId, input.guestId]
    }, "json_object('version', 1, 'kind', 'comment.delete', 'data', json_object('commentId', ?, 'deleted', json(CASE WHEN changes() = 1 THEN 'true' ELSE 'false' END)))", [input.commentId]);
    return result.request.result;
  }

  async beginAccept(ctx, shareId, suggestionId, reviewedPayload, reviewedBy) {
    const stamp = this.now();
    await this.ensureRevision(ctx, shareId);
    await ctx.db.tx([{
      sql: `UPDATE advice_suggestions SET state = 'accepting', reviewed_payload_json = ?, reviewed_payload_hash = ?, reviewed_by = ?, updated_at = ?
        WHERE share_id = ? AND id = ? AND state = 'pending'`,
      args: [json(reviewedPayload), hash(reviewedPayload), reviewedBy, stamp, shareId, suggestionId]
    }]);
    return this.suggestion(ctx, shareId, suggestionId);
  }

  async completeAccept(ctx, shareId, suggestionId, imported) {
    const result = await ctx.db.tx([
      {
        sql: `UPDATE advice_suggestions SET state = 'accepted', accepted_place_id = ?, reviewed_payload_json = NULL,
          reviewed_payload_hash = NULL, accepted_import_json = ?, updated_at = ? WHERE share_id = ? AND id = ? AND state = 'accepting'`,
        args: [imported.placeId, json(imported), this.now(), shareId, suggestionId]
      },
      {
        sql: 'UPDATE advice_revisions SET revision = revision + 1, updated_at = ? WHERE share_id = ? AND changes() = 1',
        args: [this.now(), shareId]
      }
    ]);
    return this.suggestion(ctx, shareId, suggestionId);
  }

  async rejectSuggestion(ctx, shareId, suggestionId, reviewedBy) {
    const result = await ctx.db.tx([
      {
        sql: "UPDATE advice_suggestions SET state = 'rejected', reviewed_by = ?, updated_at = ? WHERE share_id = ? AND id = ? AND state = 'pending'",
        args: [reviewedBy, this.now(), shareId, suggestionId]
      },
      {
        sql: 'UPDATE advice_revisions SET revision = revision + 1, updated_at = ? WHERE share_id = ? AND changes() = 1',
        args: [this.now(), shareId]
      }
    ]);
    assert(Number(result?.results?.[0]?.changes || 0) === 1, 'suggestion is not rejectable', 409, 'SUGGESTION_STATE_CONFLICT');
    return { suggestionId, state: 'rejected' };
  }

  async deleteComment(ctx, shareId, commentId, guestId = null) {
    const result = guestId === null
      ? await ctx.db.exec(
        'UPDATE advice_comments SET deleted_at = ? WHERE share_id = ? AND id = ? AND deleted_at IS NULL',
        this.now(), shareId, commentId
      )
      : await ctx.db.exec(
        'UPDATE advice_comments SET deleted_at = ? WHERE share_id = ? AND id = ? AND guest_id = ? AND deleted_at IS NULL',
        this.now(), shareId, commentId, guestId
      );
    return Number(result?.changes || 0) === 1;
  }

  async clearExpiredProviderDetails(ctx, shareId, now = this.now()) {
    await ctx.db.exec(
      'UPDATE advice_suggestions SET title = NULL, locality = NULL, country_code = NULL, reviewed_payload_json = NULL WHERE share_id = ? AND provider_detail_expires_at IS NOT NULL AND provider_detail_expires_at <= ?', shareId, now
    );
  }

  async eraseGuest(ctx, shareId, guestId) {
    this.forgetPresentations(shareId, guestId);
    await ctx.db.tx([
      { sql: 'DELETE FROM advice_votes WHERE share_id = ? AND guest_id = ?', args: [shareId, guestId] },
      { sql: 'DELETE FROM advice_comments WHERE share_id = ? AND guest_id = ?', args: [shareId, guestId] },
      { sql: 'DELETE FROM advice_suggestions WHERE share_id = ? AND guest_id = ?', args: [shareId, guestId] },
      { sql: 'DELETE FROM advice_requests WHERE share_id = ? AND guest_id = ?', args: [shareId, guestId] },
      { sql: 'UPDATE advice_revisions SET revision = revision + 1, updated_at = ? WHERE share_id = ?', args: [this.now(), shareId] }
    ]);
  }

  async eraseGuestAction(ctx, input) {
    this.forgetPresentations(input.shareId, input.guestId);
    await this.ensureRevision(ctx, input.shareId);
    const result = await ctx.db.tx([
      { sql: 'DELETE FROM advice_votes WHERE share_id = ? AND guest_id = ?', args: [input.shareId, input.guestId] },
      { sql: 'DELETE FROM advice_comments WHERE share_id = ? AND guest_id = ?', args: [input.shareId, input.guestId] },
      { sql: 'DELETE FROM advice_suggestions WHERE share_id = ? AND guest_id = ?', args: [input.shareId, input.guestId] },
      { sql: 'DELETE FROM advice_requests WHERE share_id = ? AND guest_id = ? AND request_id <> ?', args: [input.shareId, input.guestId, input.requestId] },
      {
        sql: `INSERT OR IGNORE INTO advice_requests (share_id, guest_id, request_id, operation, payload_hash, result_json, created_at)
          VALUES (?, ?, ?, 'session.erase', ?, ?, ?)`,
        args: [input.shareId, input.guestId, input.requestId, input.payloadHash, json({ version: 1, kind: 'session.erase', data: { erased: true } }), this.now()]
      }
    ]);
    if (result.results.slice(0, 4).some(item => Number(item.changes || 0) > 0)) await ctx.db.exec(
      'UPDATE advice_revisions SET revision = revision + 1, updated_at = ? WHERE share_id = ?', this.now(), input.shareId
    );
    return this.request(ctx, input.shareId, input.guestId, input.requestId);
  }

  async purge(ctx, shareId) {
    this.forgetPresentations(shareId);
    await ctx.db.tx([
      { sql: 'DELETE FROM advice_votes WHERE share_id = ?', args: [shareId] },
      { sql: 'DELETE FROM advice_comments WHERE share_id = ?', args: [shareId] },
      { sql: 'DELETE FROM advice_suggestions WHERE share_id = ?', args: [shareId] },
      { sql: 'DELETE FROM advice_requests WHERE share_id = ?', args: [shareId] },
      { sql: 'DELETE FROM advice_revisions WHERE share_id = ?', args: [shareId] }
    ]);
  }
}

module.exports = { AdviceStore, MIGRATIONS };
