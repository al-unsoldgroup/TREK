import { z } from 'zod';
import { idSchema, isoDateTime, nonEmptyString } from '../common/primitives.schema';
import { ADVICE_PLUGIN_ID } from './plugin-share.types';
export { ADVICE_PLUGIN_ID, ADVICE_SHARE_PERMISSION } from './plugin-share.types';

const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const title = nonEmptyString.max(200);
const label = nonEmptyString.max(100);
const id = idSchema.max(Number.MAX_SAFE_INTEGER);
const countryCodes = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
const country = z.string().refine(value => countryCodes.has(value), 'Invalid country code');
export const adviceCategorySchema = z.enum(['see', 'eat']);
const category = adviceCategorySchema;
const bounds = z.strictObject({
  south: z.number().min(-90).max(90), north: z.number().min(-90).max(90),
  west: z.number().min(-180).max(180), east: z.number().min(-180).max(180),
}).refine(b => b.south < b.north && b.west < b.east, 'Invalid or antimeridian bounds');
export const adviceShareConfigSchema = z.strictObject({
  version: z.literal(1), publicTitle: title,
  cities: z.array(z.strictObject({ id: key.refine(v => v !== 'elsewhere'), label,
    countryCodes: z.array(country).min(1).max(10), bounds })).min(1).max(40),
  stays: z.array(z.strictObject({ id: key, cityId: key, dayIds: z.array(id).min(1).max(120) })).max(120),
  schedule: z.array(z.strictObject({ assignmentId: id, publicTitle: title, category })).max(500),
  shortlist: z.array(z.strictObject({ placeId: id, cityId: key, category,
    publicTitle: title, locality: label, countryCode: country })).max(200),
}).superRefine((c, ctx) => {
  const unique = (values: Array<string | number>, field: string) => {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${field}` });
  };
  unique(c.cities.map(v => v.id), 'city'); unique(c.stays.map(v => v.id), 'stay');
  unique(c.stays.flatMap(v => v.dayIds), 'day'); unique(c.schedule.map(v => v.assignmentId), 'assignment');
  unique(c.shortlist.map(v => v.placeId), 'place');
  if (c.stays.flatMap(v => v.dayIds).length > 120) ctx.addIssue({ code: 'custom', message: 'Too many days' });
  const cities = new Set(c.cities.map(v => v.id));
  if (c.stays.some(v => !cities.has(v.cityId)) || c.shortlist.some(v => v.cityId !== 'elsewhere' && !cities.has(v.cityId))) {
    ctx.addIssue({ code: 'custom', message: 'Unknown city' });
  }
});
export const advicePlaceSchema = z.strictObject({ key: z.string().regex(/^p:[1-9][0-9]*$/), title, category,
  cityId: key, locality: label, countryCode: country, googlePlaceId: z.string().max(300).nullable(),
  mapsUrl: z.url().max(3000).refine(v => {
    const u = new URL(v);
    return u.protocol === 'https:' && u.host === 'www.google.com' && u.pathname === '/maps/search/' && !u.username && !u.password;
  }),
});
const place = advicePlaceSchema;
export const adviceProjectionSchema = z.strictObject({
  version: z.literal(1), revision: z.string().regex(/^[a-f0-9]{64}$/), title,
  cities: z.array(z.strictObject({ id: key, label, countryCodes: z.array(country).min(1).max(10) })).max(40),
  stays: z.array(z.strictObject({ id: key, cityId: key, shortlistCityId: key,
    days: z.array(z.strictObject({ key: z.string().regex(/^d:[1-9][0-9]*$/), date: z.iso.date(),
      schedule: z.array(z.strictObject({ key: z.string().regex(/^a:[1-9][0-9]*$/), place,
        time: z.string().regex(/^\d{2}:\d{2}$/).nullable(), booked: z.boolean() })).max(500),
    })).max(120),
  })).max(120),
  shortlists: z.array(z.strictObject({ cityId: key, see: z.array(place).max(200), eat: z.array(place).max(200) })).max(41),
});
export const adviceBootstrapSchema = z.strictObject({ kind: z.literal('plugin-share'), version: z.literal(1),
  plugin: z.strictObject({ id: z.literal(ADVICE_PLUGIN_ID), entry: z.literal('guest.html'), protocolVersion: z.literal(1) }),
  title, expiresAt: isoDateTime,
});
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const nonNegativeInt = z.number().int().min(0);
const actionText = (max: number) => nonEmptyString.max(max);
export const adviceReadActionSchema = z.strictObject({ version: z.literal(1), kind: z.literal('read'), commentsCursor: z.string().max(256).optional() });
export const adviceVoteActionSchema = z.strictObject({ version: z.literal(1), kind: z.literal('vote.set'), requestId: uuid,
  placeKey: z.string().min(1).max(160), value: z.union([z.literal(-1), z.literal(0), z.literal(1)]), expectedVersion: nonNegativeInt });
export const adviceCommentCreateActionSchema = z.strictObject({ version: z.literal(1), kind: z.literal('comment.create'), requestId: uuid,
  text: actionText(2000), displayName: actionText(100).optional() });
export const adviceCommentDeleteActionSchema = z.strictObject({ version: z.literal(1), kind: z.literal('comment.delete'), requestId: uuid, commentId: uuid });
export const advicePlacesAutocompleteActionSchema = z.strictObject({ version: z.literal(1), kind: z.literal('places.autocomplete'), searchId: uuid,
  cityId: key.max(80), category, input: actionText(200).refine(v => v.length >= 2, 'input must contain at least two characters'), locale: actionText(35) });
export const advicePlacesResolveActionSchema = z.strictObject({ version: z.literal(1), kind: z.literal('places.resolve'), searchId: uuid, predictionId: actionText(160) });
export const adviceSuggestionCreateActionSchema = z.strictObject({ version: z.literal(1), kind: z.literal('suggestion.create'), requestId: uuid,
  selectionId: actionText(160), category, reason: actionText(500).optional(), displayName: actionText(60).optional() });
export const adviceSuggestionWithdrawActionSchema = z.strictObject({ version: z.literal(1), kind: z.literal('suggestion.withdraw'), requestId: uuid, suggestionId: uuid });
export const adviceSessionEraseActionSchema = z.strictObject({ version: z.literal(1), kind: z.literal('session.erase'), requestId: uuid });
export const adviceActionSchema = z.discriminatedUnion('kind', [adviceReadActionSchema, adviceVoteActionSchema,
  adviceCommentCreateActionSchema, adviceCommentDeleteActionSchema, advicePlacesAutocompleteActionSchema,
  advicePlacesResolveActionSchema, adviceSuggestionCreateActionSchema, adviceSuggestionWithdrawActionSchema,
  adviceSessionEraseActionSchema]);
export const adviceInvocationSchema = z.strictObject({ version: z.literal(1), scope: z.strictObject({
  shareId: uuid, guestId: nonEmptyString.max(128), epoch: z.number().int().positive(),
}), action: adviceActionSchema });
export const adviceEmptySchema = z.strictObject({});
export const adviceOwnerWriteSchema = z.strictObject({ expectedRevision: z.number().int().min(0),
  config: adviceShareConfigSchema, enabled: z.boolean(), expiresInDays: z.number().int().min(1).max(90),
  previewRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const adviceRevisionSchema = z.strictObject({ expectedRevision: z.number().int().min(1) });

export const adviceNativeImportSchema = z.strictObject({
  tripId: idSchema, externalKey: nonEmptyString.max(200), expectedPayloadHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  place: z.strictObject({ name: actionText(200), googlePlaceId: actionText(256), address: z.string().max(500).optional(), categoryId: idSchema }),
  existingPlaceId: idSchema.optional(),
});
export const adviceNativeImportResultSchema = z.strictObject({ placeId: idSchema, created: z.boolean() });
export const adviceResolvedSelectionSchema = z.strictObject({ googlePlaceId: actionText(256), cityId: key.max(80),
  title: actionText(200), locality: z.string().max(100), countryCode: country,
  duplicate: z.strictObject({ placeKey: actionText(160), cityId: key, category }).nullable().optional(),
});
export const advicePhotoAuthorSchema = z.strictObject({ displayName: actionText(200), uri: z.url().max(2000).refine(v => {
  const parsed = new URL(v);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash;
}) });
const photoAuthor = advicePhotoAuthorSchema;
export const advicePlacesAutocompleteResultSchema = z.strictObject({
  suggestions: z.array(z.strictObject({ predictionId: actionText(160), mainText: actionText(200), secondaryText: z.string().max(300) })).max(5),
});
export const advicePlacesResolveResultSchema = z.strictObject({
  selectionId: actionText(160), place: z.strictObject({ googlePlaceId: actionText(256), cityId: key.max(80),
    title: actionText(200), locality: z.string().max(100), countryCode: country, photoHandle: actionText(160).optional() }),
});
export const advicePhotoResultSchema = z.strictObject({
  state: z.enum(['available', 'unavailable']), mimeType: z.string().regex(/^image\/(?:jpeg|png|webp)$/).nullable(),
  bytesBase64: z.string().max(750000).nullable(), authors: z.array(photoAuthor).max(20),
  googleAttribution: z.string().max(200).nullable(),
}).superRefine((value, ctx) => {
  if (value.state === 'unavailable' && (value.mimeType !== null || value.bytesBase64 !== null || value.authors.length !== 0 || value.googleAttribution !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Unavailable photos must not carry bytes or attribution' });
  }
  if (value.state === 'available' && (value.mimeType === null || value.bytesBase64 === null || value.authors.length < 0 || value.googleAttribution === null)) {
    ctx.addIssue({ code: 'custom', message: 'Available photos require bytes and complete attribution' });
  }
});
export const adviceVoteSchema = z.strictObject({ placeKey: actionText(160), positive: nonNegativeInt, negative: nonNegativeInt,
  mine: z.union([z.literal(-1), z.literal(0), z.literal(1)]), version: nonNegativeInt });
export const adviceCommentSchema = z.strictObject({ id: uuid, displayName: z.string().max(100).nullable(), text: actionText(2000), createdAt: isoDateTime, deleted: z.boolean() });
export const adviceSuggestionSchema = z.strictObject({ key: z.string().regex(/^s:[0-9a-f-]{36}$/i), title: actionText(200), category,
  cityId: key.max(80), locality: z.string().max(100), countryCode: country, googlePlaceId: actionText(256),
  mapsUrl: z.url().max(3000), state: z.enum(['pending', 'accepting', 'accepted', 'rejected', 'withdrawn']),
  reason: z.string().max(500).nullable(), displayName: z.string().max(60).nullable() });
export const adviceFeedbackReadSchema = z.strictObject({ projection: adviceProjectionSchema, feedbackRevision: nonNegativeInt,
  votes: z.array(adviceVoteSchema).max(200), myPendingSuggestions: z.array(adviceSuggestionSchema).max(200),
  myComments: z.array(adviceCommentSchema).max(50), nextCommentsCursor: z.string().max(256).nullable() });
const adviceResponseData = z.record(z.string(), z.unknown());
export const adviceFeedbackWriteSchema = z.strictObject({ version: z.literal(1), kind: z.enum(['vote.set', 'comment.create', 'comment.delete',
  'places.autocomplete', 'places.resolve', 'suggestion.create', 'suggestion.withdraw', 'session.erase']), data: adviceResponseData,
  vote: adviceVoteSchema.optional(), duplicate: z.strictObject({ placeKey: actionText(160), cityId: key, category }).optional() });

export const adviceOwnerConfigSchema = z.strictObject({
  shareId: z.string(), token: z.string().optional(), enabled: z.boolean(), revision: nonNegativeInt,
  expiresAt: isoDateTime, config: adviceShareConfigSchema,
});

const candidatePlace = z.strictObject({ placeId: id, publicTitle: title,
  lat: z.number().min(-90).max(90).nullable(), lng: z.number().min(-180).max(180).nullable() });
export const adviceOwnerCandidatesSchema = z.strictObject({
  days: z.array(z.strictObject({ id, date: z.iso.date() })).max(500),
  schedule: z.array(candidatePlace.extend({ assignmentId: id, dayId: id })).max(5000),
  shortlist: z.array(candidatePlace).max(5000),
});
export type AdviceOwnerCandidates = z.infer<typeof adviceOwnerCandidatesSchema>;

export type AdviceCategory = z.infer<typeof adviceCategorySchema>;
export type AdviceShareConfig = z.infer<typeof adviceShareConfigSchema>;
export type AdvicePlace = z.infer<typeof advicePlaceSchema>;
export type AdviceProjection = z.infer<typeof adviceProjectionSchema>;
export type AdviceBootstrap = z.infer<typeof adviceBootstrapSchema>;
export type AdviceUuid = z.infer<typeof uuid>;
export type AdviceReadAction = z.infer<typeof adviceReadActionSchema>;
export type AdviceVoteAction = z.infer<typeof adviceVoteActionSchema>;
export type AdviceCommentCreateAction = z.infer<typeof adviceCommentCreateActionSchema>;
export type AdviceCommentDeleteAction = z.infer<typeof adviceCommentDeleteActionSchema>;
export type AdvicePlacesAutocompleteAction = z.infer<typeof advicePlacesAutocompleteActionSchema>;
export type AdvicePlacesResolveAction = z.infer<typeof advicePlacesResolveActionSchema>;
export type AdvicePlacePrediction = z.infer<typeof advicePlacesAutocompleteResultSchema>['suggestions'][number];
export type AdvicePlacesAutocompleteResult = z.infer<typeof advicePlacesAutocompleteResultSchema>;
export type AdviceResolvedPlace = z.infer<typeof advicePlacesResolveResultSchema>['place'];
export type AdvicePlacesResolveResult = z.infer<typeof advicePlacesResolveResultSchema>;
export type AdviceSuggestionCreateAction = z.infer<typeof adviceSuggestionCreateActionSchema>;
export type AdviceSuggestionWithdrawAction = z.infer<typeof adviceSuggestionWithdrawActionSchema>;
export type AdviceSessionEraseAction = z.infer<typeof adviceSessionEraseActionSchema>;
export type AdviceAction = z.infer<typeof adviceActionSchema>;
export type AdviceVote = z.infer<typeof adviceVoteSchema>;
export type AdviceDuplicate = NonNullable<z.infer<typeof adviceFeedbackWriteSchema>['duplicate']>;
export type AdviceComment = z.infer<typeof adviceCommentSchema>;
export type AdviceSuggestion = z.infer<typeof adviceSuggestionSchema>;
export type AdviceReadResult = z.infer<typeof adviceFeedbackReadSchema>;
export type AdviceWriteResponse = z.infer<typeof adviceFeedbackWriteSchema>;
export type AdviceResolvedSelection = z.infer<typeof adviceResolvedSelectionSchema>;
export type AdvicePhotoAuthor = z.infer<typeof advicePhotoAuthorSchema>;
export type AdvicePhotoResult = z.infer<typeof advicePhotoResultSchema>;
export type AdviceNativeImport = z.infer<typeof adviceNativeImportSchema>;
export type AdviceNativeImportResult = z.infer<typeof adviceNativeImportResultSchema>;
export type AdviceOwnerConfig = z.infer<typeof adviceOwnerConfigSchema>;
export type AdviceShareInvocation = z.infer<typeof adviceInvocationSchema>;

export interface AdviceOwnerShareContext {
  getConfig(input: { tripId: number }): Promise<AdviceOwnerConfig | null>;
  getCandidates(input: { tripId: number }): Promise<AdviceOwnerCandidates>;
  preview(input: { tripId: number; config: AdviceShareConfig }): Promise<AdviceProjection>;
  configure(input: { tripId: number; expectedRevision: number; config: AdviceShareConfig;
    enabled: boolean; expiresInDays: number; previewRevision?: string }): Promise<AdviceOwnerConfig>;
  importSuggestion(input: AdviceNativeImport): Promise<AdviceNativeImportResult>;
}

export interface AdvicePublicShareContext {
  snapshot(): Promise<AdviceProjection>;
  resolveSelection(input: { selectionId: string }): Promise<AdviceResolvedSelection>;
  readonly owner: AdviceOwnerShareContext;
}

// The action union and this checklist must change together. The first equality
// catches an omitted or extra schema member; each Extract check catches a stale
// discriminant or a member whose shape drifted from its schema.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type AdviceActionChecklist =
  | z.infer<typeof adviceReadActionSchema>
  | z.infer<typeof adviceVoteActionSchema>
  | z.infer<typeof adviceCommentCreateActionSchema>
  | z.infer<typeof adviceCommentDeleteActionSchema>
  | z.infer<typeof advicePlacesAutocompleteActionSchema>
  | z.infer<typeof advicePlacesResolveActionSchema>
  | z.infer<typeof adviceSuggestionCreateActionSchema>
  | z.infer<typeof adviceSuggestionWithdrawActionSchema>
  | z.infer<typeof adviceSessionEraseActionSchema>;
export const ADVICE_ACTION_PARITY: [
  Equal<AdviceAction, AdviceActionChecklist>,
  Equal<AdviceReadAction, Extract<AdviceAction, { kind: 'read' }>>,
  Equal<AdviceVoteAction, Extract<AdviceAction, { kind: 'vote.set' }>>,
  Equal<AdviceCommentCreateAction, Extract<AdviceAction, { kind: 'comment.create' }>>,
  Equal<AdviceCommentDeleteAction, Extract<AdviceAction, { kind: 'comment.delete' }>>,
  Equal<AdvicePlacesAutocompleteAction, Extract<AdviceAction, { kind: 'places.autocomplete' }>>,
  Equal<AdvicePlacesResolveAction, Extract<AdviceAction, { kind: 'places.resolve' }>>,
  Equal<AdviceSuggestionCreateAction, Extract<AdviceAction, { kind: 'suggestion.create' }>>,
  Equal<AdviceSuggestionWithdrawAction, Extract<AdviceAction, { kind: 'suggestion.withdraw' }>>,
  Equal<AdviceSessionEraseAction, Extract<AdviceAction, { kind: 'session.erase' }>>,
] = [true, true, true, true, true, true, true, true, true, true];
