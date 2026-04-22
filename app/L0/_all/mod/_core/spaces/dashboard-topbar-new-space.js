import { createDashboardSpace } from "/mod/_core/spaces/dashboard-actions.js";
import { showToast } from "/mod/_core/visual/chrome/toast.js";

globalThis.spacesDashboardTopbarNewSpace = function spacesDashboardTopbarNewSpace() {
  return {
    creating: false,

    async createSpace() {
      if (this.creating) {
        return;
      }

      this.creating = true;

      try {
        await createDashboardSpace();
      } catch (error) {
        showToast(String(error?.message || "Unable to create the space."), {
          tone: "error"
        });
      } finally {
        this.creating = false;
      }
    }
  };
};
