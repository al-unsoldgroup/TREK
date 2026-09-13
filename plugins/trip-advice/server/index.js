'use strict';

const { store, publicHandle, routeHandler, responseFor } = require('./lib/advice-service');

async function lifecycleScope(ctx, input) {
  if (!input || typeof input.shareId !== 'string') throw new Error('shareId is required');
  return input;
}

const plugin = {
  async onLoad(ctx) {
    await store.migrate(ctx);
  },

  publicShare: {
    async handle(input, ctx) {
      return publicHandle(input, ctx);
    },

    /* Called by the host after a link is disabled, deleted, or expires past its
     * retention window. It only touches this plugin's database. */
    async purge(input, ctx) {
      await store.purge(ctx, (await lifecycleScope(ctx, input)).shareId);
    },

    /* Called by the host's guest-erasure flow. The host supplies the bound
     * principal, so neither identifier is read from an HTTP body. */
    async eraseGuest(input, ctx) {
      const scope = await lifecycleScope(ctx, input);
      if (typeof scope.guestId !== 'string' || !scope.guestId) throw new Error('guestId is required');
      await store.eraseGuest(ctx, scope.shareId, scope.guestId);
    }
  },

  routes: [
    { method: 'GET', path: '/owner', auth: true, handler: (req, ctx) => routeHandler(req, ctx, 'read') },
    { method: 'PUT', path: '/owner', auth: true, handler: (req, ctx) => routeHandler(req, ctx, 'configure') },
    { method: 'PUT', path: '/owner/config', auth: true, handler: (req, ctx) => routeHandler(req, ctx, 'configure') },
    { method: 'POST', path: '/owner/preview', auth: true, handler: (req, ctx) => routeHandler(req, ctx, 'preview') },
    { method: 'POST', path: '/owner/suggestions/accept', auth: true, handler: (req, ctx) => routeHandler(req, ctx, 'accept') },
    { method: 'POST', path: '/owner/suggestions/reject', auth: true, handler: (req, ctx) => routeHandler(req, ctx, 'reject') },
    { method: 'POST', path: '/owner/comments/delete', auth: true, handler: (req, ctx) => routeHandler(req, ctx, 'comment-delete') },
    { method: 'POST', path: '/owner/purge-feedback', auth: true, handler: (req, ctx) => routeHandler(req, ctx, 'purge') }
  ]
};

module.exports = plugin;
module.exports.responseFor = responseFor;
