import { Outlet } from "react-router";

/** Prepare sub-routes render their own screen toolbar (Plan | Stories tabs). */
export default function PrepareLayout() {
  return <Outlet />;
}
