import { t } from "../i18n.js";

export class SettingsTab {
  render(container, configEntryId) {
    const href = configEntryId ? `/config/integrations/integration/span_panel#config_entry=${configEntryId}` : "/config/integrations/integration/span_panel";

    container.innerHTML = `
      <div style="padding:16px;">
        <h2 style="margin-top:0;">${t("settings.heading")}</h2>
        <p style="color:var(--secondary-text-color);margin-bottom:16px;">
          ${t("settings.description")}
        </p>
        <a href="${href}"
           style="color:var(--primary-color);text-decoration:none;">
          ${t("settings.open_link")} &rarr;
        </a>
      </div>
    `;
  }
}
