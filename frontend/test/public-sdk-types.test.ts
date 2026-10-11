import { expect, it } from "vitest";
import type * as Public from "../../contracts/addons/v3/browser-sdk.js";
import type { BrowserAddonContext, BrowserContributionBinding } from "../src/addons/browser-sdk.js";
import type { BrowserContributionElementContext } from "../src/addons/contribution-outlet.js";
import type { AddonDataMutation, AddonQueryOptions } from "../src/addons/data-client.js";
import type { BrowserContributionSurface } from "../src/addons/generation-manager.js";
import type { RuleDetails } from "../src/addons/rule-details.js";
import type {
  BrowserServiceCallOptions,
  BrowserServiceConnectOptions,
} from "../src/addons/service-client.js";

// The checks are compile-time: `npm run typecheck` fails when the host stops
// satisfying the public contract that add-ons copy.
type Assignable<From, To> = [From] extends [To] ? true : false;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const checks: readonly true[] = [
  true satisfies Assignable<BrowserAddonContext, Public.AddonContext>,
  true satisfies Assignable<BrowserContributionElementContext, Public.ContributionElementContext>,
  true satisfies Same<BrowserContributionSurface, Public.ContributionSurface>,
  // Method parameters are compared loosely, so check what add-ons pass in.
  true satisfies Assignable<Public.QueryOptions, AddonQueryOptions>,
  true satisfies Assignable<Public.DataMutation, AddonDataMutation>,
  true satisfies Assignable<Public.ServiceCallOptions, BrowserServiceCallOptions>,
  true satisfies Assignable<
    Parameters<Public.ServiceAPI["connect"]>[1],
    BrowserServiceConnectOptions
  >,
  true satisfies Assignable<Public.ContributionBinding, BrowserContributionBinding>,
  true satisfies Assignable<Public.RuleDetails, RuleDetails>,
];

it("keeps the host implementation within the public browser SDK types", () => {
  expect(checks.every(Boolean)).toBe(true);
});
