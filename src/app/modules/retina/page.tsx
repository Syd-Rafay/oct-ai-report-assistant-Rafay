import { AppShell } from "@/components/app-shell";
import { LockedModuleView } from "@/components/views";

export default function Page() {
  return (
    <AppShell>
      <LockedModuleView
        moduleName="Retinal Fundus Screening"
        owner="Retina Service"
        description="Retinal/fundus disease screening module for DR, glaucoma-style findings, and report output once the retina API is available."
      />
    </AppShell>
  );
}
