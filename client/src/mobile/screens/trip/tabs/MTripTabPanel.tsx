import type { MTripTabPanelProps } from '../MTripShell'
import { TabScroller } from './tabChrome'
import MTransportsTab from './MTransportsTab'
import MBookingsTab from './MBookingsTab'
import MCostsTab from './MCostsTab'
import MFilesTab from './MFilesTab'
import MCollabTab from './MCollabTab'
import MListsTab from './MListsTab'
import MRoadtripTab from '../roadtrip/MRoadtripTab'
import MJourneyDetail from '../../journey/MJourneyDetail'
import PluginFrame from '../../../../components/Plugins/PluginFrame'
import TripAdviceSurface from '../../../../features/tripAdvice/TripAdviceSurface'
import { useTripAdviceOwner } from '../../../../features/tripAdvice/useTripAdviceOwner'

function NativeTripAdviceOwner({ tripId }: { tripId: number }) {
  return <TripAdviceSurface controller={useTripAdviceOwner(tripId)} />
}

/**
 * Routes the active non-plan trip tab to its panel. `tab` is the legacy id the
 * desktop planner uses (transports · buchungen · finanzplan · listen · dateien ·
 * collab · plugin:<id>); addon/plugin gating already happened in the shell, so
 * only enabled tabs ever reach here. Panels are wired in as they are built
 * (spec analysis/03-trip-tabs.md); an unbuilt tab shows its empty scroll body
 * while the surrounding chrome (top controls, day chips, dock) stays usable.
 */
export default function MTripTabPanel({ planner, shell, tab }: MTripTabPanelProps) {
  // Trip-page plugin tab — the same sandboxed frame the desktop planner mounts,
  // running edge to edge UNDER the floating controls and the dock, exactly as
  // every native mobile screen does. Boxing the frame inside those two clearances
  // was the safe first move and it reads wrong: a full-bleed plugin (a map, most
  // obviously) stops short of the screen on both ends and leaves a dead band the
  // native tabs do not have.
  //
  // The clearances are not lost, they are handed over: `trek:context` already
  // carries viewport.insets for this exact surface, computed from the same
  // --m-safe-top / --bottom-nav-h variables TabScroller uses. A plugin pads its
  // own chrome by them and lets its background run the whole way, which is the
  // only arrangement that can put content behind a floating control. A plugin
  // that ignores them puts its first row under the back button — the contract is
  // stated in the context payload, not enforced here.
  //
  // The frame also states its surface, so the plugin knows it is expected to fill
  // and scroll itself rather than report a height.
  //
  // color-scheme is pinned for the same reason both settings mounts pin it:
  // Chromium paints a white canvas behind a transparent frame otherwise.
  if (tab.startsWith('plugin:')) {
    const tripId = Number(planner.tripId)
    return (
      <div className="absolute inset-0">
        {tab === 'plugin:trip-advice' && Number.isSafeInteger(tripId) && tripId > 0
          ? <NativeTripAdviceOwner tripId={tripId} />
          : <PluginFrame
              pluginId={tab.slice('plugin:'.length)}
              tripId={planner.tripId != null ? String(planner.tripId) : null}
              dayId={planner.pluginTabDayId != null ? String(planner.pluginTabDayId) : null}
              fill
              surface="trip-tab"
              className="h-full w-full [color-scheme:light]"
            />}
      </div>
    )
  }
  switch (tab) {
    case 'transports':
      return <MTransportsTab planner={planner} shell={shell} />
    case 'buchungen':
      return <MBookingsTab planner={planner} shell={shell} />
    case 'finanzplan':
      return <MCostsTab planner={planner} shell={shell} />
    case 'dateien':
      return <MFilesTab planner={planner} shell={shell} />
    case 'collab':
      return <MCollabTab planner={planner} shell={shell} />
    case 'listen':
      return <MListsTab planner={planner} shell={shell} />
    // The only tab with two halves of its own: the chain, or the same map showing
    // the stage. Both are this one component, because they share a stage and the
    // switch between them must not lose it.
    case 'roadtrip':
      return <MRoadtripTab planner={planner} shell={shell} tab={tab} />
    // The journal the trip links: the Journey addon's own phone screen, moved
    // below the trip's floating top controls: its bars measure from --m-safe-top.
    case 'journal':
      return planner.journalId == null ? null : (
        <div className="absolute inset-0 overflow-hidden [--m-safe-top:calc(env(safe-area-inset-top,0px)+62px)]">
          <MJourneyDetail journeyId={planner.journalId} embedded />
        </div>
      )
    default:
      return <TabScroller>{null}</TabScroller>
  }
}
