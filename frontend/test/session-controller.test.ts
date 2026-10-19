import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddonOutletsController } from "../src/app/addon-outlets-controller.js";
import { BusyLeases } from "../src/app/busy-lease.js";
import type { CampaignController } from "../src/app/campaign-controller.js";
import type { NavigationGuard } from "../src/app/navigation-guard.js";
import { SessionController } from "../src/app/session-controller.js";
import { uiText } from "../src/app/ui-localization.js";
import type {
  EventRefresh,
  EventStreamCallbacks,
  SharedEventStream,
} from "../src/core/event-stream.js";

const token = (letter: string) => letter.repeat(32);
const signedIn = (role: "dm" | "player", csrf = token("a"), realRole = role) => ({
  ok: true,
  role,
  realRole,
  csrfToken: csrf,
  expiresAt: "2026-10-20T12:00:00Z",
});
const signedOut = { role: null, realRole: null };

interface Lifecycle {
  hostConnected?: () => void;
  hostDisconnected?: () => void;
}

/** A session over a host that answers from `server`, which a test may change. */
function session(auth: unknown, { failAuth = false } = {}) {
  const server = { auth, login: auth, failAuth, requests: [] as string[] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      server.requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/health") return Response.json({ status: "ok", version: "1.2.3" });
      if (path === "/api/auth")
        return server.failAuth
          ? Response.json({ error: "unavailable" }, { status: 503 })
          : Response.json(server.auth);
      if (path === "/api/login") return Response.json(server.login);
      if (path === "/api/logout") return Response.json({ ok: true });
      throw new Error(`unexpected ${path}`);
    }),
  );
  vi.stubGlobal("window", new EventTarget());
  const controllers: Lifecycle[] = [];
  const element = {
    addController: (controller: Lifecycle) => controllers.push(controller),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  };
  const campaign = {
    load: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    reset: vi.fn(),
    restored: vi.fn(async () => true),
  };
  const addons = {
    composition: undefined,
    generation: 0,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    renewCsrfToken: vi.fn(),
  };
  const guard = { editing: false, hostEditing: false, confirmDiscard: vi.fn(() => true) };
  let live: EventStreamCallbacks | undefined;
  const events = {
    open: vi.fn((callbacks: EventStreamCallbacks) => {
      live = callbacks;
    }),
    close: vi.fn(),
  };
  const report = vi.fn();
  const left = vi.fn();
  const resumed = vi.fn();
  const controller = new SessionController(element, {
    campaign: campaign as unknown as CampaignController,
    addons: addons as unknown as AddonOutletsController,
    busy: new BusyLeases(() => undefined),
    guard: guard as unknown as NavigationGuard,
    report,
    signedOut: left,
    resumed,
    events: events as unknown as SharedEventStream,
  });
  for (const item of controllers) item.hostConnected?.();
  return {
    controller,
    server,
    campaign,
    addons,
    guard,
    events,
    report,
    signedOut: left,
    resumed,
    /** Waits until the start-up reads finished and live updates are open. */
    started: () => vi.waitFor(() => expect(events.open).toHaveBeenCalled()),
    /** A live update arrives. */
    arrive: (event: EventRefresh) => live?.onRefresh(event, new AbortController().signal),
    disconnect: () => controllers.forEach((item) => item.hostDisconnected?.()),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("SessionController", () => {
  it("starts from the host's session: campaign, live updates, then add-ons", async () => {
    const { controller, campaign, addons, started } = session(signedIn("dm"));
    await started();
    await vi.waitFor(() => expect(addons.start).toHaveBeenCalledOnce());
    expect(controller.canManage).toBe(true);
    expect(controller.role).toBe("dm");
    expect(campaign.load).toHaveBeenCalledOnce();
    expect(controller.readiness).toEqual({
      state: "ready",
      health: { status: "ok", version: "1.2.3" },
    });
  });

  it("continues signed out when the session cannot be read", async () => {
    const { controller, addons, report, started } = session(signedIn("dm"), { failAuth: true });
    await started();
    expect(controller.authenticated).toBe(false);
    expect(addons.start).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/^Session check failed/u));
  });

  it("passes a renewed token to the add-ons and waits to resume an ended session", async () => {
    const { controller, server, addons, events, started } = session(signedIn("dm"));
    await started();
    server.auth = signedIn("dm", token("b"));
    expect(await controller.check()).toBe(true);
    expect(addons.renewCsrfToken).toHaveBeenCalledWith(token("b"));
    expect(controller.auth).toMatchObject({ csrfToken: token("b") });
    server.auth = signedOut;
    expect(await controller.check()).toBe(false);
    expect(controller.recovering).toBe(true);
    expect(controller.liveState).toBe("reconnecting");
    expect(events.close).toHaveBeenCalled();
    // Open views keep the signed-in authority until the session resumes.
    expect(controller.canManage).toBe(true);
  });

  it("resumes only as the same role, then reloads in place", async () => {
    const { controller, server, campaign, addons, events, resumed, started } = session(
      signedIn("dm"),
    );
    await started();
    server.auth = signedOut;
    await controller.check();
    server.login = signedIn("player");
    expect(await controller.resume("password")).toBe(false);
    expect(controller.recoveryError).toBe(uiText("session.sameRole"));
    expect(controller.recovering).toBe(true);
    server.login = signedIn("dm", token("c"));
    addons.start.mockClear();
    events.open.mockClear();
    expect(await controller.resume("password")).toBe(true);
    expect(controller.recovering).toBe(false);
    expect(controller.restored).toBe(true);
    expect(campaign.load).toHaveBeenLastCalledWith(expect.any(AbortSignal), true);
    expect(events.open).toHaveBeenCalledOnce();
    expect(addons.start).toHaveBeenCalledOnce();
    expect(resumed).toHaveBeenCalledOnce();
  });

  it("signs in, reloading the campaign and add-ons for the new session", async () => {
    const { controller, server, campaign, addons, started } = session(signedOut);
    await started();
    expect(addons.start).not.toHaveBeenCalled();
    server.login = signedIn("player");
    await controller.login("password");
    expect(controller.role).toBe("player");
    expect(campaign.reload).toHaveBeenCalledOnce();
    expect(addons.start).toHaveBeenCalledOnce();
  });

  it("asks before signing out, then continues signed out", async () => {
    const {
      controller,
      server,
      guard,
      campaign,
      addons,
      signedOut: left,
      started,
    } = session(signedIn("dm"));
    await started();
    guard.confirmDiscard.mockReturnValueOnce(false);
    await controller.logout();
    expect(server.requests).not.toContain("POST /api/logout");
    await controller.logout();
    expect(server.requests).toContain("POST /api/logout");
    expect(addons.stop).toHaveBeenCalledOnce();
    expect(controller.authenticated).toBe(false);
    expect(campaign.reload).toHaveBeenCalledOnce();
    expect(left).toHaveBeenCalledOnce();
  });

  it("keeps the session for open host edits when the add-ons lose their authority", async () => {
    const { controller, guard, campaign, addons, started } = session(signedIn("dm"));
    await started();
    await vi.waitFor(() => expect(addons.start).toHaveBeenCalledOnce());
    guard.hostEditing = true;
    controller.addonAuthorityLost(new AbortController().signal, () => true);
    await vi.waitFor(() => expect(addons.start).toHaveBeenCalledTimes(2));
    expect(controller.authenticated).toBe(true);
    guard.hostEditing = false;
    controller.addonAuthorityLost(new AbortController().signal, () => true);
    expect(controller.authenticated).toBe(false);
    expect(campaign.reset).toHaveBeenCalledOnce();
  });

  it("asks before restarting add-ons over open edits after a restore", async () => {
    const { campaign, guard, addons, report, arrive, started } = session(signedIn("dm"));
    await started();
    await vi.waitFor(() => expect(addons.start).toHaveBeenCalledOnce());
    guard.editing = true;
    arrive({ cause: "campaign-restored", cursor: 2 });
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(uiText("recovery.openEdits")));
    expect(addons.start).toHaveBeenCalledOnce();
    guard.editing = false;
    arrive({ cause: "campaign-restored", cursor: 3 });
    await vi.waitFor(() => expect(addons.start).toHaveBeenCalledTimes(2));
    expect(campaign.restored).toHaveBeenCalledTimes(2);
  });

  it("stops listening when the app leaves the page", async () => {
    const { events, disconnect, started } = session(signedIn("dm"));
    await started();
    disconnect();
    expect(events.close).toHaveBeenCalled();
  });
});
