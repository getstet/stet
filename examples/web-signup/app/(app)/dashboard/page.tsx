'use client';

import { useCopy } from '@getstet/stet/react';

import { fill } from '@/lib/fill';
import { useSession } from '@/lib/session';

export default function DashboardPage() {
  const copy = useCopy();
  const user = useSession();
  if (!user) return null;
  return (
    <div className="page">
      <h1 className="title">{fill(copy('dashboard_greeting'), { name: user.name })}</h1>
      <section className="card">
        <h2 className="section-title">{copy('dashboard_projects_title')}</h2>
        {user.projects.length === 0 ? (
          <p className="empty">{copy('dashboard_projects_empty')}</p>
        ) : (
          <ul className="project-list">
            {user.projects.map((project) => (
              <li key={project.id} className="project">
                <span className="project-name">{project.name}</span>
                <span className="project-updated">{fill(copy('dashboard_project_updated'), { date: project.updated })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
