import { Link, Navigate, Outlet, Route, Routes, useParams } from "react-router";
import { Shell } from "@/components/shell";
import { Button, Card, EmptyState } from "@/components/ui";
import Home from "@/pages/home";
import Target from "@/pages/target";
import PrepareLayout from "@/pages/prepare/layout";
import PrepPlan from "@/pages/prepare/plan";
import Stories from "@/pages/prepare/stories";
import Interview from "@/pages/interview/index";
import InterviewSession from "@/pages/interview/session";
import LoopPage from "@/pages/interview/loop";
import Readiness from "@/pages/readiness";
import Resume from "@/pages/resume";
import History from "@/pages/history";
import Skills from "@/pages/skills";
import Settings from "@/pages/settings";

function NotFound() {
  return (
    <Card className="mx-auto mt-16 max-w-xl">
      <EmptyState
        title="Page not found"
        description="That page doesn't exist."
        action={
          <Link to="/">
            <Button variant="secondary">Back to home</Button>
          </Link>
        }
      />
    </Card>
  );
}

function InterviewSessionRoute() {
  const { id } = useParams();
  return <InterviewSession key={id} />;
}

export function App() {
  return (
    <Routes>
      <Route element={<Shell><Outlet /></Shell>}>
        <Route index element={<Home />} />
        <Route path="target" element={<Target />} />
        <Route path="prepare" element={<PrepareLayout />}>
          <Route index element={<PrepPlan />} />
          <Route path="stories" element={<Stories />} />
        </Route>
        <Route path="interview" element={<Interview />} />
        <Route path="interview/:id" element={<InterviewSessionRoute />} />
        <Route path="interview/loop/:id" element={<LoopPage />} />
        <Route path="readiness" element={<Readiness />} />
        <Route path="resume" element={<Resume />} />
        <Route path="history" element={<History />} />
        <Route path="skills" element={<Skills />} />
        <Route path="settings" element={<Settings />} />
        <Route path="prep" element={<Navigate to="/prepare" replace />} />
        <Route path="stories" element={<Navigate to="/prepare/stories" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
