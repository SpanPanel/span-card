import { DashboardController } from "../src/core/dashboard-controller.js";
import { ErrorStore } from "../src/core/error-store.js";

/**
 * A dashboard controller as its owner builds it: with the error store of the
 * view it draws for, the card's or the sidebar dashboard's.
 */
export function dashboardController(store: ErrorStore = new ErrorStore()): DashboardController {
  return new DashboardController(store);
}
