import type { AdviceProjectionV2, AdviceShareConfigV2, AdvicePhotoResult, AdviceVote, AdvicePlacePrediction, AdviceMapTileResult, AdviceSuggestionV2, AdvicePlacesResolveResultV2, AdviceCommentAnchorV2, AdvicePlacesMetadataResultV2 } from '@trek/shared'

export type AdvicePlaceView = AdviceProjectionV2['shortlists'][number]['see'][number]
export type AdviceDayView = AdviceProjectionV2['stays'][number]['days'][number]
export type VisibilityField = 'hiddenCityKeys' | 'hiddenDayKeys' | 'hiddenNoteDayKeys' | 'hiddenPlaceKeys' | 'hiddenIdeaKeys'
export interface AdviceSelection {
  selectionId: string
  place: AdvicePlacesResolveResultV2['place']
}
export interface RecommendationContext { cityId: string; dayKey?: string; category: 'see' | 'eat'; full?: boolean }
export interface RecommendationDialogContext extends RecommendationContext { suggestion?: AdvicePendingView }
export interface AdviceSuggestionInput extends RecommendationContext { selectionId: string; reason?: string; displayName?: string }
export type AdviceSuggestionUpdateInput = Omit<AdviceSuggestionInput, 'selectionId' | 'dayKey'> & { selectionId?: string; dayKey?: string | null }
export interface AdviceCommentView { id: string; text: string; displayName?: string | null; anchor?: AdviceCommentAnchorV2 }
export type AdvicePendingView = AdviceSuggestionV2
export interface TripAdviceOwnerControls {
  config: AdviceShareConfigV2
  saving: boolean
  saveState: string
  legacy?: boolean
  upgrade?(): Promise<void>
  setVisibility(field: VisibilityField, key: string): Promise<void>
  setShowNotes(value: boolean): Promise<void>
  copyLink(): Promise<void>
  searchCities(input: string): Promise<AdvicePlacePrediction[]>
  addCity(predictionId: string): Promise<void>
}
/** Online-only, validated host adapter. Rendering never receives tokens or private trip records. */
export interface TripAdviceController {
  mode: 'owner' | 'guest'
  readonly?: boolean
  projection: AdviceProjectionV2 | null
  loading: boolean
  error: string | null
  status: string
  erased: boolean
  votes: AdviceVote[]
  comments: AdviceCommentView[]
  suggestions: AdvicePendingView[]
  owner?: TripAdviceOwnerControls
  vote(placeKey: string, value: -1 | 0 | 1): Promise<void>
  comment(text: string, displayName?: string, anchor?: AdviceCommentAnchorV2): Promise<void>
  deleteComment(id: string): Promise<void>
  erase(): Promise<void>
  autocomplete(context: RecommendationContext, input: string, searchId: string): Promise<AdvicePlacePrediction[]>
  resolve(searchId: string, predictionId: string): Promise<AdviceSelection>
  suggest(input: AdviceSuggestionInput): Promise<void>
  updateSuggestion(suggestionId: string, input: AdviceSuggestionUpdateInput): Promise<void>
  photo(handle: string): Promise<AdvicePhotoResult>
  metadata(placeKey: string): Promise<AdvicePlacesMetadataResultV2>
  mapTile(dayKey: string, z: number, x: number, y: number): Promise<AdviceMapTileResult>
}
