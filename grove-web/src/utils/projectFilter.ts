import type { Project } from "../data/types";

/** Filter projects by type. 'coding' matches everything that is NOT studio. */
export function filterProjectsByType(projects: Project[], type: "coding" | "studio"): Project[] {
  if (type === "studio") {
    return projects.filter((p) => p.projectType === "studio");
  }
  return projects.filter((p) => p.projectType !== "studio");
}