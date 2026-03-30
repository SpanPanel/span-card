export class SettingsTab {
  render(container, configEntryId) {
    const href = configEntryId ? `/config/integrations/integration/span_panel#config_entry=${configEntryId}` : "/config/integrations/integration/span_panel";

    container.innerHTML = `
      <div style="padding:16px;">
        <h2 style="margin-top:0;">Settings</h2>
        <p style="color:var(--secondary-text-color);margin-bottom:16px;">
          General integration settings (entity naming, device prefix,
          circuit numbers) are managed through the integration's options flow.
        </p>
        <a href="${href}"
           style="color:var(--primary-color);text-decoration:none;">
          Open SPAN Panel Integration Settings &rarr;
        </a>
      </div>
    `;
  }
}
