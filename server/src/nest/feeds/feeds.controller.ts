import {
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FeedsService, parseUserFeedOptions } from './feeds.service';
import { etagMatches } from './feeds.cache';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { User } from '../../types';
import { db } from '../../db/database';

// Resolve the public origin used to build feed URLs. APP_URL wins — it is the
// canonical externally-reachable URL behind a reverse proxy. When it is unset
// (the default on a plain `docker run`), fall back to the request's own host so
// the link is still absolute and copy-pasteable as webcal:// instead of a dead
// relative path.
function resolveFeedBase(req: Request): string {
  const configured = (process.env.APP_URL || '').replace(/\/$/, '');
  if (configured) return configured;
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : '';
}

/**
 * Send a built feed, or a bodiless 304 when the client's copy is still current.
 *
 * `no-store` would forbid the client from keeping the copy that makes a
 * conditional request possible at all, so this is `private, no-cache`: never
 * held by a shared proxy (the URL's token is a credential), always revalidated,
 * but reusable by the subscriber it belongs to. That revalidation is the whole
 * point — a full-history all-trips feed is megabytes, and a calendar refetches
 * it on a timer for as long as the subscription exists.
 */
function sendFeed(
  req: Request,
  res: Response,
  built: { ics: string; etag: string },
  filename: string,
): void {
  res.setHeader('ETag', built.etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('X-Published-TTL', 'PT1H');
  if (etagMatches(req.get('if-none-match'), built.etag)) {
    res.status(304).end();
    return;
  }
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(built.ics);
}

/**
 * Public subscribable ICS feed endpoints — no auth required.
 * The secret token in the URL acts as the access credential.
 */
@Controller('api/feed')
export class FeedsPublicController {
  constructor(private readonly feeds: FeedsService) {}

  @Get('trip/:token.ics')
  tripFeed(@Param('token') token: string, @Req() req: Request, @Res() res: Response): void {
    const result = this.feeds.buildTripIcs(token);
    if (!result) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }
    sendFeed(req, res, result, result.filename);
  }

  // `?history=<days>|all` widens the window past the default 90 days of finished
  // trips; `?detail=trips` drops the per-day and reservation events, leaving one
  // all-day span per trip. Both ride in the URL because a calendar client stores
  // the URL and re-fetches it verbatim — there is no session to hang them off.
  @Get('user/:token.ics')
  userFeed(
    @Param('token') token: string,
    @Query('history') history: string | undefined,
    @Query('detail') detail: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    const result = this.feeds.buildUserIcs(token, parseUserFeedOptions(history, detail));
    if (!result) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }
    sendFeed(req, res, result, 'all-trips.ics');
  }
}

/**
 * Authenticated token management for a single trip's feed.
 *   POST   = enable (mint a token, idempotent)
 *   PUT    = rotate (new token, invalidates the old URL)
 *   DELETE = disable (clear the token, public URL stops resolving)
 */
@Controller('api/trips/:tripId/feed')
@UseGuards(JwtAuthGuard)
export class TripFeedTokenController {
  constructor(private readonly feeds: FeedsService) {}

  private assertAccess(tripId: string, userId: number): void {
    const row = db
      .prepare(
        'SELECT id FROM trips WHERE id = ? AND (user_id = ? OR id IN (SELECT trip_id FROM trip_members WHERE user_id = ?))',
      )
      .get(tripId, userId, userId);
    if (!row) throw new HttpException({ error: 'Trip not found' }, 404);
  }

  @Get('token')
  get(@CurrentUser() user: User, @Param('tripId') tripId: string, @Req() req: Request) {
    return this.feeds.getTripToken(tripId, user.id, resolveFeedBase(req));
  }

  @Post('token')
  generate(@CurrentUser() user: User, @Param('tripId') tripId: string, @Req() req: Request) {
    this.assertAccess(tripId, user.id);
    return this.feeds.generateTripToken(tripId, user.id, resolveFeedBase(req));
  }

  @Put('token')
  rotate(@CurrentUser() user: User, @Param('tripId') tripId: string, @Req() req: Request) {
    this.assertAccess(tripId, user.id);
    return this.feeds.rotateTripToken(tripId, resolveFeedBase(req));
  }

  @Delete('token')
  disable(@CurrentUser() user: User, @Param('tripId') tripId: string) {
    this.assertAccess(tripId, user.id);
    this.feeds.disableTripToken(tripId);
    return { feed_url: null };
  }
}

/**
 * Authenticated token management for the all-trips (per-user) feed.
 *   POST   = enable   PUT = rotate   DELETE = disable
 */
@Controller('api/feed/user')
@UseGuards(JwtAuthGuard)
export class UserFeedTokenController {
  constructor(private readonly feeds: FeedsService) {}

  @Get('token')
  get(@CurrentUser() user: User, @Req() req: Request) {
    return this.feeds.getUserToken(user.id, resolveFeedBase(req));
  }

  @Post('token')
  generate(@CurrentUser() user: User, @Req() req: Request) {
    return this.feeds.generateUserToken(user.id, resolveFeedBase(req));
  }

  @Put('token')
  rotate(@CurrentUser() user: User, @Req() req: Request) {
    return this.feeds.rotateUserToken(user.id, resolveFeedBase(req));
  }

  @Delete('token')
  disable(@CurrentUser() user: User) {
    this.feeds.disableUserToken(user.id);
    return { feed_url: null };
  }
}
