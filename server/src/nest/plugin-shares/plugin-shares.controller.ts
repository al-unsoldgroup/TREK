import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, HttpException, NotFoundException, Optional, Param, Post, Put, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ADVICE_PLUGIN_ID, advicePublicActionSchema, adviceReadResultV2Schema, adviceWriteResponseV2Schema, advicePlacesResolveResultV2Schema, adviceFeedbackReadSchema, adviceFeedbackWriteSchema, advicePlacesAutocompleteResultSchema, advicePlacesResolveResultSchema, advicePlacesMetadataResultSchema, advicePhotoResultSchema, idParamSchema } from '@trek/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Public } from '../auth/public.decorator';
import type { User } from '../../types';
import { PluginRuntimeService } from '../plugins/plugin-runtime.service';
import { PluginSharesService, ADVICE_COOKIE } from './plugin-shares.service';
import { GooglePlacesProvider } from './google-places.provider';
import { AdviceActionDto, AdviceConfigDto, AdviceOwnerWriteDto, AdviceRevisionDto, AdviceSessionDto } from './plugin-shares.dto';
import { adviceMapTileResultSchema } from '@trek/shared';
import { AdviceMapProvider } from './advice-map.provider';

function tripIdParam(value: string): number {
  const parsed = idParamSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid trip ID');
  return parsed.data;
}

@Controller('api/trips/:tripId/share-link/plugins/trip-advice')
@UseGuards(JwtAuthGuard)
export class PluginShareOwnerController {
  constructor(private readonly shares: PluginSharesService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Param('tripId') tripId: string, @CurrentUser() user: User) { return this.shares.getOwner(tripIdParam(tripId), user); }
  @Put()
  @Header('Cache-Control', 'no-store')
  put(@Param('tripId') tripId: string, @CurrentUser() user: User, @Body() body: AdviceOwnerWriteDto) { return this.shares.write(tripIdParam(tripId), user, body); }
  @Post('preview')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  preview(@Param('tripId') tripId: string, @CurrentUser() user: User, @Body() body: AdviceConfigDto) { return this.shares.preview(tripIdParam(tripId), user, body); }
  @Delete()
  @Header('Cache-Control', 'no-store')
  remove(@Param('tripId') tripId: string, @CurrentUser() user: User, @Body() body: AdviceRevisionDto) { return this.shares.revoke(tripIdParam(tripId), user, body.expectedRevision, false); }
  @Post('rotate')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  rotate(@Param('tripId') tripId: string, @CurrentUser() user: User, @Body() body: AdviceRevisionDto) { return this.shares.revoke(tripIdParam(tripId), user, body.expectedRevision, true); }
}

@Controller('api/shared/:token/plugins/trip-advice')
export class PluginSharePublicController {
  private readonly inflight = new Map<string, number>();
  constructor(private readonly shares: PluginSharesService, private readonly runtime: PluginRuntimeService, @Optional() private readonly places?: GooglePlacesProvider,
    @Optional() private readonly maps?: AdviceMapProvider) {}
  private headers(res: Response) { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); }
  @Post('session')
  @HttpCode(200)
  @Public('separate advice token plus exact same-origin check; issues only a share-scoped anonymous session')
  session(@Param('token') token: string, @Body() _body: AdviceSessionDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.headers(res);
    this.shares.requireOrigin(req.get('origin'), req.get('sec-fetch-site'));
    const session = this.shares.session(token, this.shares.credential(req.get('cookie')), req.ip ?? 'unknown');
    res.cookie(ADVICE_COOKIE, session.credential, { secure: true, httpOnly: true, sameSite: 'strict', path: this.shares.cookiePath(token), expires: new Date(session.expiresAt) });
    return { csrfToken: session.csrfToken, expiresAt: session.expiresAt };
  }
  @Post('actions')
  @HttpCode(200)
  @Public('advice token, scoped session and CSRF validated; only versioned read action, never general plugin routes')
  async action(@Param('token') token: string, @Body() body: AdviceActionDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const action = advicePublicActionSchema.parse(body);
    this.headers(res);
    this.shares.requireOrigin(req.get('origin'), req.get('sec-fetch-site'));
    const credential = this.shares.credential(req.get('cookie'));
    const csrfToken = req.get('x-trek-advice-csrf');
    const principal = action.kind === 'map.tile' || action.kind === 'places.metadata'
      ? this.shares.authorizeMedia(token, credential, csrfToken)
      : this.shares.authorize(token, credential, csrfToken);
    if (!this.runtime.isActive(ADVICE_PLUGIN_ID) || !this.runtime.grantsOf(ADVICE_PLUGIN_ID).has('share:guest')) throw new NotFoundException('Invalid or expired link');
    const count = this.inflight.get(principal.shareId) ?? 0;
    if (count >= 4) { res.set('Retry-After', '5'); throw new HttpException('Advice request limit reached', 429); }
    this.inflight.set(principal.shareId, count + 1);
    let result: unknown;
    try {
      if (action.kind === 'map.tile' && !this.maps) throw new ServiceUnavailableException('Map provider is unavailable');
      result = action.kind === 'map.tile'
        ? await this.maps!.tile(principal, { ...action, version: 1 })
        : action.kind === 'places.autocomplete'
        ? await (this.places ?? unavailableProvider()).autocomplete(principal, { ...action, version: 1 })
        : action.kind === 'places.resolve'
          ? action.version === 2
            ? await (this.places ?? unavailableProvider()).resolveActionV2(principal, { ...action, version: 1 })
            : await (this.places ?? unavailableProvider()).resolveAction(principal, action)
          : action.kind === 'places.metadata'
            ? await (this.places ?? unavailableProvider()).metadata(principal, { ...action, version: 1 })
            : await this.runtime.invokePublicShare(principal, action);
    }
    catch (error) { if (error instanceof HttpException) throw error; throw new ServiceUnavailableException('Advice temporarily unavailable'); }
    finally {
      const remaining = this.inflight.get(principal.shareId)! - 1;
      if (remaining) this.inflight.set(principal.shareId, remaining); else this.inflight.delete(principal.shareId);
    }
    this.shares.validatePrincipal(principal);
    const parsed = action.kind === 'map.tile' ? adviceMapTileResultSchema.safeParse(result)
      : action.kind === 'read' ? (action.version === 2 ? adviceReadResultV2Schema : adviceFeedbackReadSchema).safeParse(result)
      : action.kind === 'places.autocomplete' ? advicePlacesAutocompleteResultSchema.safeParse((result as { data?: unknown }).data)
        : action.kind === 'places.resolve' ? (action.version === 2 ? advicePlacesResolveResultV2Schema : advicePlacesResolveResultSchema).safeParse((result as { data?: unknown }).data)
          : action.kind === 'places.metadata' ? advicePlacesMetadataResultSchema.safeParse((result as { data?: unknown }).data)
            : (action.version === 2 ? adviceWriteResponseV2Schema : adviceFeedbackWriteSchema).safeParse(result);
    if (!parsed.success) throw new ServiceUnavailableException('Advice temporarily unavailable');
    if (action.kind === 'session.erase') {
      if (!('kind' in parsed.data) || parsed.data.kind !== 'session.erase' || parsed.data.data.erased !== true) {
        throw new ServiceUnavailableException('Advice erasure was not confirmed');
      }
      this.shares.completeGuestErasure(principal);
      res.clearCookie(ADVICE_COOKIE, { secure: true, httpOnly: true, sameSite: 'strict', path: this.shares.cookiePath(token) });
    }
    if (action.kind === 'places.autocomplete' || action.kind === 'places.resolve' || action.kind === 'places.metadata' || action.kind === 'map.tile') {
      if (action.version === 2 && action.kind === 'places.metadata') {
        const { placeType, ...data } = advicePlacesMetadataResultSchema.parse(parsed.data);
        return { version: 2, kind: action.kind, data: { ...data, ...(placeType ? { primaryType: placeType } : {}) } };
      }
      return { version: action.version, kind: action.kind, data: parsed.data };
    }
    return parsed.data;
  }
  @Get('photos/:handle')
  @HttpCode(200)
  @Public('advice token, scoped session and same-origin request; delivers only a transient attributed photo envelope')
  async photo(@Param('token') token: string, @Param('handle') handle: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.headers(res);
    this.shares.requireOrigin(req.get('origin'), req.get('sec-fetch-site'));
    const principal = this.shares.authorizePhoto(token, this.shares.credential(req.get('cookie')), req.get('x-trek-advice-csrf'));
    try {
      const result = await (this.places ?? unavailableProvider()).photo(principal, handle);
      this.shares.validatePrincipal(principal);
      return advicePhotoResultSchema.parse(result);
    } catch (error) { if (error instanceof HttpException) throw error; throw new ServiceUnavailableException('Advice temporarily unavailable'); }
  }
}

function unavailableProvider(): never { throw new ServiceUnavailableException('Google Places provider is unavailable'); }
