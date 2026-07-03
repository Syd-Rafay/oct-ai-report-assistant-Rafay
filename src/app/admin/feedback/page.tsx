import { AppShell } from "@/components/app-shell";
import { FeedbackReviewView } from "@/components/views";

export default function Page() {
  return (
    <AppShell>
      <FeedbackReviewView scope="admin" />
    </AppShell>
  );
}
