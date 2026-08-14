// ---------------------------------------------------------------------------
// App — Pluvus Platform (Phase 10: Workflow Builder + Observability)
// ---------------------------------------------------------------------------
// Views:
//   campaigns  — campaign list + creation wizard
//   builder    — workflow builder (canvas, config, enroll, launch, monitor)
//   observe    — observability dashboard (Phase 9, lazy-loaded)
//
// Routing is state-based (no react-router dependency) but MIRRORED TO THE URL
// HASH so a page refresh (or a shared link) restores the same view — e.g.
// `#/builder/<workflowId>` reopens that workflow instead of dumping the user
// back on the campaign list.

import { Suspense, lazy, useState, useEffect, useCallback } from "react";
import { Sun, Moon } from "lucide-react";
import { CampaignList } from "./components/builder/CampaignList";
import { CampaignIntake } from "./components/builder/campaignIntake/CampaignIntake";
import { WorkflowBuilder } from "./components/builder/WorkflowBuilder";
import { ToastProvider } from "./components/ds";
import { useThemeMode } from "./theme-mode";
import { colors, font, radii } from "./theme";

// Lazy-load the observability dashboard so its React Flow graph + inspector
// stack stay out of the builder's initial bundle.
const ObservabilityView = lazy(() => import("./components/ObservabilityView"));
const PartnersView = lazy(() =>
  import("./components/partners/PartnersView").then((m) => ({ default: m.PartnersView })),
);

type View = "campaigns" | "builder" | "observe" | "partners" | "intake";

interface Route {
  view: View;
  activeWorkflowId: string | null;
  // PLU-139 (2a): the campaign whose sectioned brief intake is open. Deep-linked
  // as `#/intake/<campaignId>` so a refresh reopens the same campaign's brief.
  activeCampaignId: string | null;
}

// -- URL hash <-> route serialization ---------------------------------------
// Formats: `#/campaigns`, `#/observe`, `#/builder/<workflowId>`, `#/intake/<campaignId>`.
function parseHash(): Route {
  const raw = (typeof window !== "undefined" ? window.location.hash : "").replace(/^#\/?/, "");
  const [view, id] = raw.split("/");
  if (view === "builder" && id)
    return { view: "builder", activeWorkflowId: decodeURIComponent(id), activeCampaignId: null };
  if (view === "intake" && id)
    return { view: "intake", activeWorkflowId: null, activeCampaignId: decodeURIComponent(id) };
  if (view === "observe") return { view: "observe", activeWorkflowId: null, activeCampaignId: null };
  if (view === "partners") return { view: "partners", activeWorkflowId: null, activeCampaignId: null };
  return { view: "campaigns", activeWorkflowId: null, activeCampaignId: null };
}

function routeToHash(r: Route): string {
  if (r.view === "builder" && r.activeWorkflowId) {
    return `#/builder/${encodeURIComponent(r.activeWorkflowId)}`;
  }
  if (r.view === "intake" && r.activeCampaignId) {
    return `#/intake/${encodeURIComponent(r.activeCampaignId)}`;
  }
  if (r.view === "observe") return "#/observe";
  if (r.view === "partners") return "#/partners";
  return "#/campaigns";
}

export default function App() {
  const [{ view, activeWorkflowId, activeCampaignId }, setRoute] = useState<Route>(parseHash);

  // Keep the URL hash in sync with the current route (so refresh restores it).
  useEffect(() => {
    const target = routeToHash({ view, activeWorkflowId, activeCampaignId });
    if (window.location.hash !== target) {
      window.history.replaceState(null, "", target);
    }
  }, [view, activeWorkflowId, activeCampaignId]);

  // Respond to browser back/forward + manual hash edits.
  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setView = useCallback((v: View) => {
    setRoute((prev) => ({
      view: v,
      activeWorkflowId: v === "builder" ? prev.activeWorkflowId : null,
      activeCampaignId: v === "intake" ? prev.activeCampaignId : null,
    }));
  }, []);

  const openWorkflow = useCallback((id: string) => {
    setRoute({ view: "builder", activeWorkflowId: id, activeCampaignId: null });
  }, []);

  // PLU-139 (2a): open a campaign's sectioned brief intake.
  const openIntake = useCallback((campaignId: string) => {
    setRoute({ view: "intake", activeWorkflowId: null, activeCampaignId: campaignId });
  }, []);

  const backToCampaigns = useCallback(() => {
    setRoute({ view: "campaigns", activeWorkflowId: null, activeCampaignId: null });
  }, []);

  return (
    <ToastProvider>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: colors.bg }}>
        <AppTopbar view={view} onChangeView={setView} />
        <div style={{ flex: 1, minHeight: 0 }}>
          {view === "campaigns" && (
            <CampaignList onSelectWorkflow={openWorkflow} onOpenIntake={openIntake} />
          )}
          {view === "intake" && activeCampaignId && (
            <CampaignIntake
              campaignId={activeCampaignId}
              onBack={backToCampaigns}
              onOpenCampaign={openIntake}
            />
          )}
          {view === "intake" && !activeCampaignId && (
            <CampaignList onSelectWorkflow={openWorkflow} onOpenIntake={openIntake} />
          )}
          {view === "builder" && activeWorkflowId && (
            <WorkflowBuilder workflowId={activeWorkflowId} onBack={backToCampaigns} />
          )}
          {view === "builder" && !activeWorkflowId && (
            <CampaignList onSelectWorkflow={openWorkflow} onOpenIntake={openIntake} />
          )}
          {view === "observe" && (
            <Suspense fallback={<Center>Loading observability…</Center>}>
              <ObservabilityView />
            </Suspense>
          )}
          {view === "partners" && (
            <Suspense fallback={<Center>Loading partners…</Center>}>
              <PartnersView />
            </Suspense>
          )}
        </div>
      </div>
    </ToastProvider>
  );
}

// ---------------------------------------------------------------------------
// App-level topbar with view switcher
// ---------------------------------------------------------------------------

function AppTopbar({ view, onChangeView }: { view: View; onChangeView: (v: View) => void }) {
  const { mode, toggle } = useThemeMode();
  const tabs: { key: View; label: string }[] = [
    { key: "campaigns", label: "Builder" },
    { key: "observe", label: "Observability" },
    { key: "partners", label: "Partners" },
  ];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 20,
        borderBottom: `2px solid ${colors.cardBorder}`,
        background: colors.panel,
        flexShrink: 0,
        height: 54,
        padding: "0 20px",
      }}
    >
      {/* Serif wordmark with an accent tick — the Tano editorial mark. */}
      <button
        onClick={() => onChangeView("campaigns")}
        className="ds-focusable"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <span aria-hidden style={{ width: 4, height: 18, borderRadius: 2, background: colors.accent }} />
        <span
          className="serif"
          style={{
            fontSize: 22,
            fontWeight: font.weight.black,
            color: colors.text,
            letterSpacing: -0.6,
          }}
        >
          Pluvus
        </span>
      </button>
      <div aria-hidden style={{ width: 2, height: 20, background: colors.hairline }} />
      <div style={{ display: "flex", alignItems: "center", gap: 4 }} role="tablist">
        {tabs.map((tab) => {
          const activeView =
            view === tab.key || (tab.key === "campaigns" && view === "builder");
          return (
            <button
              key={tab.key}
              onClick={() => onChangeView(tab.key)}
              role="tab"
              aria-selected={activeView}
              className="ds-focusable"
              style={{
                height: 34,
                padding: "0 14px",
                // Active tab = a solid sticker pill with the ink outline.
                background: activeView ? colors.accent : "transparent",
                border: `2px solid ${activeView ? colors.cardBorder : "transparent"}`,
                borderRadius: radii.pill,
                color: activeView ? "#fff" : colors.textMuted,
                fontSize: font.size.md,
                fontWeight: font.weight.semibold,
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Theme toggle — sticker icon button, far right. */}
      <button
        onClick={toggle}
        aria-label={mode === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        title={mode === "dark" ? "Light theme" : "Dark theme"}
        className="ds-focusable ds-btn"
        style={{
          marginLeft: "auto",
          width: 38,
          height: 38,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: colors.panel,
          border: `2px solid ${colors.cardBorder}`,
          borderRadius: radii.pill,
          color: colors.text,
          cursor: "pointer",
        }}
      >
        {mode === "dark" ? <Sun size={17} strokeWidth={2.25} /> : <Moon size={17} strokeWidth={2.25} />}
      </button>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: colors.textMuted,
        fontSize: font.size.md,
      }}
    >
      {children}
    </div>
  );
}
