import type { Ref } from 'react';
import { NavIcon, IconButton, DropdownMenu, DropdownSection, DropdownDivider, DropdownItem } from '../../shared';
import { useUiStore } from '../../stores/uiStore';
import { useThreadsStore } from '../../stores/threadsStore';

export function ProjectsHeaderActions() {
  const collapseAll = useUiStore((s) => s.collapseAllProjects);
  const projects = useThreadsStore((s) => s.projects);
  const groupBy = useUiStore((s) => s.projectsGroupBy);
  const sortBy = useUiStore((s) => s.projectsSortBy);
  const setGroupBy = useUiStore((s) => s.setProjectsGroupBy);
  const setSortBy = useUiStore((s) => s.setProjectsSortBy);

  const onAddProject = async () => {
    try {
      const p = await window.kydog.invoke('project.open');
      useThreadsStore.setState((s) => ({
        projects: [...s.projects.filter(x => x.path !== p.path), p],
      }));
    } catch (err) {
      console.error('add-project failed', err);
    }
  };

  return (
    <div className="flex items-center gap-0.5">
      <IconButton
        size={22}
        tone="faint"
        tooltip="全部收起"
        ariaLabel="全部收起"
        testId="projects-collapse-all"
        onClick={() => collapseAll(projects.map((p) => p.path))}
      >
        <NavIcon name="minimize-2" size={14} />
      </IconButton>

      <DropdownMenu
        align="right"
        width={220}
        testId="projects-filter-menu"
        trigger={({ open, toggle, ref }) => (
          <IconButton
            ref={ref as Ref<HTMLButtonElement>}
            size={22}
            tone="faint"
            tooltip={open ? undefined : '筛选、排序和整理对话'}
            ariaLabel="筛选、排序和整理对话"
            active={open}
            testId="projects-filter-trigger"
            onClick={toggle}
          >
            <NavIcon name="filter" size={14} />
          </IconButton>
        )}
      >
        <DropdownSection title="整理">
          <DropdownItem
            icon={<NavIcon name="folder" size={14} />}
            label="按项目"
            checked={groupBy === 'project'}
            testId="filter-group-project"
            onClick={() => setGroupBy('project')}
          />
          <DropdownItem
            icon={<NavIcon name="clock" size={14} />}
            label="按时间顺序"
            checked={groupBy === 'time'}
            testId="filter-group-time"
            onClick={() => setGroupBy('time')}
          />
        </DropdownSection>
        <DropdownDivider />
        <DropdownSection title="排序条件">
          <DropdownItem
            icon={<NavIcon name="circle-plus" size={14} />}
            label="创建时间"
            checked={sortBy === 'created'}
            testId="filter-sort-created"
            onClick={() => setSortBy('created')}
          />
          <DropdownItem
            icon={<NavIcon name="pencil-line" size={14} />}
            label="更新时间"
            checked={sortBy === 'updated'}
            testId="filter-sort-updated"
            onClick={() => setSortBy('updated')}
          />
        </DropdownSection>
      </DropdownMenu>

      <IconButton
        size={22}
        tone="faint"
        tooltip="添加新项目"
        ariaLabel="添加新项目"
        testId="add-project-trigger"
        onClick={onAddProject}
      >
        <NavIcon name="folder-plus" size={14} />
      </IconButton>
    </div>
  );
}
