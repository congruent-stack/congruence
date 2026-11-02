import { Activity, FolderGit2 } from 'lucide-react';

// Built-in panels are deliberately simple. A future plugin API can grow from this registry.
export const panels = {
  activity: { title: 'Agent activity', icon: Activity },
  repositories: { title: 'Repositories', icon: FolderGit2 },
} as const;
