import { Injectable, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getAppUrl } from '../../app-config/app-url';
import { PluginSharesService } from '../plugin-shares/plugin-shares.service';
import { PUBLIC_DIR } from '../platform/platform.routes';
import { ShareService } from './share.service';

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
    private readonly share: ShareService,
    private readonly advice: PluginSharesService,
  ) {}

  render(token: string): string | null {
    let metadata: SharedPageMetadata | null;
    try {
      metadata = this.advice.ownsToken(token)
        ? this.advice.socialMetadata(token)
        : this.share.getSocialMetadata(token);
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
    if (!metadata) return null;
    this.template ??= readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const url = new URL(`/shared/${encodeURIComponent(token)}`, `${getAppUrl()}/`).href;
    return renderSharedPageMetadata(this.template, metadata, url);
  }
}
