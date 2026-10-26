import { HttpException, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getAppUrl } from '../../app-config/app-url';
import { PluginSharesService } from '../plugin-shares/plugin-shares.service';
import { PUBLIC_DIR } from '../platform/platform.routes';
import { PluginShareDb } from '../plugin-shares/plugin-share-db';

export interface SharedPageMetadata {
  title: string;
  description: string | null;
  coverImage: string | null;
}

const DEFAULT_DESCRIPTION = 'View the trip plan and share recommendations.';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function socialImage(coverImage: string | null, shareUrl: string): string | null {
  if (!coverImage?.trim()) return null;
  try {
    const origin = new URL(shareUrl).origin;
    const raw = coverImage.trim();
    const source = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') ? raw : `/uploads/${raw}`;
    const image = new URL(source, `${origin}/`);
    if (!['http:', 'https:'].includes(image.protocol) || image.username || image.password || image.hash) return null;
    return image.href;
  } catch {
    return null;
  }
}

export function renderSharedPageMetadata(template: string, metadata: SharedPageMetadata, shareUrl: string): string {
  const title = escapeHtml(metadata.title.trim().slice(0, 200) || 'TREK');
  const description = escapeHtml((metadata.description?.trim().replace(/\s+/g, ' ') || DEFAULT_DESCRIPTION).slice(0, 300));
  const url = escapeHtml(shareUrl);
  const image = socialImage(metadata.coverImage, shareUrl);
  const imageTags = image ? [
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:image:alt" content="${title} cover" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ] : [];
  const tags = [
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="TREK" />',
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    ...imageTags,
  ].join('\n    ');
  const titled = template.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${title}</title>`);
  return titled.replace(/<\/head>/i, () => `    ${tags}\n  </head>`);
}

@Injectable()
export class SharedPageService {
  private template: string | null = null;

  constructor(
    private readonly db: PluginShareDb,
    private readonly advice: PluginSharesService,
  ) {}

  /** A legacy share link's trip, for its preview card. Null when the link is unknown or expired. */
  private legacyMetadata(token: string): SharedPageMetadata | null {
    const row = this.db.get<{ title: string; description: string | null; cover_image: string | null }>(`
      SELECT t.title, t.description, t.cover_image
      FROM share_tokens s
      JOIN trips t ON t.id = s.trip_id
      WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
    `, token);
    return row ? { title: row.title, description: row.description, coverImage: row.cover_image } : null;
  }

  render(token: string): string | null {
    let metadata: SharedPageMetadata | null;
    try {
      metadata = this.advice.ownsToken(token)
        ? this.advice.socialMetadata(token)
        : this.legacyMetadata(token);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 404) return null;
      throw error;
    }
    if (!metadata) return null;
    this.template ??= readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const url = new URL(`/shared/${encodeURIComponent(token)}`, `${getAppUrl()}/`).href;
    return renderSharedPageMetadata(this.template, metadata, url);
  }
}
