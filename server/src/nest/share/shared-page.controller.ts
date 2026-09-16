import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import path from 'node:path';
import { readEnv } from '../../app-config';
import { Public } from '../auth/public.decorator';
import { PUBLIC_DIR } from '../platform/platform.routes';
import { SharedPageService } from './shared-page.service';

@Public('share-token page: metadata and content are restricted to the unguessable public link')
@Controller('shared')
export class SharedPageController {
  constructor(private readonly pages: SharedPageService) {}

  @Get(':token')
  read(@Param('token') token: string, @Res() res: Response): void {
    if (readEnv().app.nodeEnv !== 'production') throw new NotFoundException('Not Found');
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    });
    const html = this.pages.render(token);
    if (html) {
      res.type('html').send(html);
      return;
    }
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
}
