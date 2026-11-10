import { X } from "lucide-react";
import type { ProjectListItem } from "../../api";
import type { Project } from "../../data/types";
import { LinkedProjectPicker } from "../../components/Tasks/TaskDetail/tabs/LinkedProjectPicker";
import { Card } from "../ui";
import type { ProjectLinksView } from "./useProjectLinks";

interface ProjectLinksCardProps {
  view: ProjectLinksView;
  /** Other projects that could be linked (exists, not archived, not this one). */
  linkable: Project[];
}

function toListItem(project: Project): ProjectListItem {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    added_at: project.addedAt.toISOString(),
    task_count: project.taskCount ?? 0,
    live_count: 0,
    is_git_repo: project.isGitRepo,
    exists: project.exists,
    project_type: project.projectType,
    archived: project.archived,
  };
}

/** The Project's default linked projects: what every new task starts linked to. */
export function ProjectLinksCard({ view, linkable }: ProjectLinksCardProps) {
  const { links, saving, error, save } = view;
  if (!view.available || !links) return null;
  const linkedIds = new Set(links.map((link) => link.id));
  const candidates = linkable.filter((project) => !linkedIds.has(project.id)).map(toListItem);
  return (
    <Card
      className="odb-plinks oui-rise"
      style={{ animationDelay: "180ms" }}
      aria-label="Linked projects"
      title="Linked projects"
      actions={(
        <LinkedProjectPicker
          projects={candidates}
          disabled={saving || candidates.length === 0}
          onSelect={(project) => void save([...links.map((link) => link.id), project.id])}
          triggerClassName="oui-btn oui-btn-ghost oui-btn-sm oui-btn-icon"
          triggerLabel="Link project"
          triggerIconOnly
        />
      )}
    >
      <div className="odb-plinks-in">
        {links.length === 0 ? <div className="odb-tl-none">None yet.</div> : null}
        {links.map((link) => (
          <div key={link.id} className={`odb-tl-row${link.exists ? "" : " is-missing"}`}>
            <span className="odb-pav" aria-hidden="true">{link.name.charAt(0)}</span>
            <span className="oui-truncate">{link.name}</span>
            {!link.exists ? <span className="odb-src">{link.archived ? "archived" : "missing"}</span> : null}
            <button
              type="button"
              className="odb-x"
              aria-label={`Unlink ${link.name}`}
              disabled={saving}
              onClick={() => void save(links.filter((item) => item.id !== link.id).map((item) => item.id))}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        ))}
        {error && !saving ? <div className="odb-tl-error" role="alert">{error}</div> : null}
      </div>
    </Card>
  );
}
