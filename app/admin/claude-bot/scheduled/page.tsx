import { AdminShell } from "@/components/admin/AdminShell";
import ScheduledTasksApp from "@/components/admin/claude-bot/ScheduledTasksApp";

export const dynamic = "force-dynamic";

export default function ScheduledTasksPage() {
  return (
    <AdminShell
      title="Scheduled prompts"
      subtitle="Prompts that fire automatically on a schedule. The cron route /api/cron/scheduled-tasks should be hit at least as often as your shortest interval."
      back={{ href: "/admin/claude-bot", label: "Back to Claude bridge" }}
    >
      <ScheduledTasksApp />
    </AdminShell>
  );
}
