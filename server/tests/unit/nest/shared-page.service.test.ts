import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SharedPageController } from '../../../src/nest/share/shared-page.controller';
import { renderSharedPageMetadata, SharedPageService } from '../../../src/nest/share/shared-page.service';

const INDEX = '<!doctype html><html><head><title>TREK</title></head><body><div id="root"></div></body></html>';

describe('public shared-page social metadata', () => {
  function service(options: {
    ownsToken?: boolean;
    pluginMetadata?: { title: string; description: string | null; coverImage: string | null } | Error;
    legacyMetadata?: { title: string; description: string | null; coverImage: string | null } | null;
  }) {
    const advice = {
      ownsToken: vi.fn().mockReturnValue(options.ownsToken ?? false),
      socialMetadata: options.pluginMetadata instanceof Error
        ? vi.fn().mockImplementation(() => { throw options.pluginMetadata; })
        : vi.fn().mockReturnValue(options.pluginMetadata),
    };
    const share = { getSocialMetadata: vi.fn().mockReturnValue(options.legacyMetadata ?? null) };
    const pages = new SharedPageService(share as never, advice as never);
    (pages as unknown as { template: string | null }).template = INDEX;
    return { pages, share, advice };
  }

  it('USG-231 renders escaped Open Graph and Twitter metadata from the trip', () => {
    const html = renderSharedPageMetadata(INDEX, {
      title: 'Japan & Anne <2026>',
      description: 'Food, cities & “quiet days”',
      coverImage: '/uploads/covers/japan.jpg',
    }, 'https://trips.unsold.group/shared/ta_token');

    expect(html).toContain('<title>Japan &amp; Anne &lt;2026&gt;</title>');
    expect(html).toContain('<meta property="og:title" content="Japan &amp; Anne &lt;2026&gt;" />');
    expect(html).toContain('<meta property="og:description" content="Food, cities &amp; “quiet days”" />');
    expect(html).toContain('<meta property="og:image" content="https://trips.unsold.group/uploads/covers/japan.jpg" />');
    expect(html).toContain('<meta property="og:url" content="https://trips.unsold.group/shared/ta_token" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<meta name="twitter:image" content="https://trips.unsold.group/uploads/covers/japan.jpg" />');
    expect(html).not.toContain('Japan & Anne <2026>');
  });

  it('USG-231 omits image tags and uses a safe default description when no cover or description exists', () => {
    const html = renderSharedPageMetadata(INDEX, {
      title: 'Japan',
      description: null,
      coverImage: null,
    }, 'https://trips.unsold.group/shared/token');

    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain('View the trip plan and share recommendations.');
    expect(html).not.toContain('property="og:image"');
    expect(html).not.toContain('name="twitter:image"');
  });

  it('USG-231 rejects non-http cover URLs instead of injecting active content', () => {
    const html = renderSharedPageMetadata(INDEX, {
      title: 'Japan',
      description: 'Autumn trip',
      coverImage: 'data:image/svg+xml,<svg onload=alert(1)>',
    }, 'https://trips.unsold.group/shared/token');

    expect(html).not.toContain('property="og:image"');
    expect(html).not.toContain('data:image');
  });

  it('USG-231 omits the image when the public page URL cannot provide an origin', () => {
    const html = renderSharedPageMetadata(INDEX, {
      title: 'Japan',
      description: 'Autumn trip',
      coverImage: '/uploads/japan.jpg',
    }, 'not a URL');

    expect(html).not.toContain('property="og:image"');
  });

  it('USG-231 keeps replacement-pattern characters literal', () => {
    const html = renderSharedPageMetadata(INDEX, {
      title: '$& $` $\'',
      description: 'Keep $& literal',
      coverImage: null,
    }, 'https://trips.unsold.group/shared/token');

    expect(html).toContain('<title>$&amp; $` $&#39;</title>');
    expect(html).toContain('content="Keep $&amp; literal"');
    expect(html.match(/<title>/g)).toHaveLength(1);
  });

  it('USG-231 resolves live plugin and legacy metadata through their token authorities', () => {
    const plugin = service({ ownsToken: true, pluginMetadata: { title: 'Plugin Japan', description: 'Spring', coverImage: null } });
    expect(plugin.pages.render('ta_' + 'A'.repeat(32))).toContain('content="Plugin Japan"');
    expect(plugin.advice.socialMetadata).toHaveBeenCalledOnce();
    expect(plugin.share.getSocialMetadata).not.toHaveBeenCalled();

    const legacy = service({ legacyMetadata: { title: 'Legacy Japan', description: null, coverImage: null } });
    expect(legacy.pages.render('legacy-token')).toContain('content="Legacy Japan"');
    expect(legacy.share.getSocialMetadata).toHaveBeenCalledWith('legacy-token');
  });

  it('USG-231 falls back to the SPA for unavailable or unknown links', () => {
    const unavailable = service({ ownsToken: true, pluginMetadata: new NotFoundException('Invalid or expired link') });
    expect(unavailable.pages.render('ta_' + 'A'.repeat(32))).toBeNull();
    expect(service({}).pages.render('unknown')).toBeNull();
  });

  it('USG-231 does not hide unexpected metadata failures', () => {
    const failure = new Error('database unavailable');
    const broken = service({ ownsToken: true, pluginMetadata: failure });

    expect(() => broken.pages.render('ta_' + 'A'.repeat(32))).toThrow(failure);
  });
});

describe('SharedPageController', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  function response() {
    const value = {
      set: vi.fn(),
      type: vi.fn(),
      send: vi.fn(),
      sendFile: vi.fn(),
    };
    value.type.mockReturnValue(value);
    return value as unknown as Response;
  }

  it('USG-231 leaves shared-page routing to the development SPA outside production', () => {
    process.env.NODE_ENV = 'development';
    const pages = { render: vi.fn() };
    const controller = new SharedPageController(pages as never);

    expect(() => controller.read('token', response())).toThrowError(NotFoundException);
    expect(pages.render).not.toHaveBeenCalled();
  });

  it('USG-231 serves the rendered social preview with private-cache headers in production', () => {
    process.env.NODE_ENV = 'production';
    const pages = { render: vi.fn().mockReturnValue('<html>Japan</html>') };
    const controller = new SharedPageController(pages as never);
    const res = response();

    controller.read('token', res);

    expect(res.set).toHaveBeenCalledWith({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    });
    expect(pages.render).toHaveBeenCalledWith('token');
    expect(res.type).toHaveBeenCalledWith('html');
    expect(res.send).toHaveBeenCalledWith('<html>Japan</html>');
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('USG-231 serves the SPA shell when the share is unavailable', () => {
    process.env.NODE_ENV = 'production';
    const pages = { render: vi.fn().mockReturnValue(null) };
    const controller = new SharedPageController(pages as never);
    const res = response();

    controller.read('missing', res);

    expect(res.sendFile).toHaveBeenCalledOnce();
    expect(String(vi.mocked(res.sendFile).mock.calls[0][0])).toMatch(/index\.html$/);
    expect(res.send).not.toHaveBeenCalled();
  });
});
