import { AppShell } from "@/components/app-shell";
import { LockedModuleView } from "@/components/views";

export default function Page() {
  return (
    <AppShell>
      <LockedModuleView
        moduleName="Corneal / VKG Detection"
        owner="Corneal Service"
        description="Keratoconus and corneal disease screening from VKG/topography images. This module uses its own patients, reports, feedback, templates, and model API key."
      />
    </AppShell>
  );
}
