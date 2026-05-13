import { z } from 'zod';

export const OWNER_TYPES = [
  'frontend-dev',
  'backend-dev',
  'db-architect',
  'devops-engineer',
  'qa-engineer',
  'security-auditor',
  'design-engineer',
  'integration',
] as const;

export const PRIORITIES = ['P0', 'P1', 'P2'] as const;

export const TASK_TYPES = [
  'foundation',
  'data',
  'backend',
  'integration',
  'content',
  'infra',
] as const;

export const ESTIMATES = ['S', 'M', 'L', 'XL'] as const;

export const PHASE_STATUSES = ['active', 'blocked', 'done'] as const;

export const TaskSchema = z.object({
  id: z.string().regex(/^P\d+-T\d+[a-z]?$/),
  tracker_issue_id: z.string().optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  type: z.enum(TASK_TYPES),
  priority: z.enum(PRIORITIES),
  depends_on: z.array(z.string().min(1)).default([]),
  estimate: z.enum(ESTIMATES),
  owner_type: z.enum(OWNER_TYPES),
  acceptance: z.array(z.string().min(1)).min(1),
  split_into: z.array(z.string().min(1)).optional(),
});

export const PhaseSchema = z.object({
  id: z.string().regex(/^phase-\d+$/),
  tracker_milestone_id: z.string().optional(),
  name: z.string().min(1),
  status: z.enum(PHASE_STATUSES),
  blocked_by: z.string().optional(),
  goal: z.string().min(1),
  gate_criteria: z.array(z.string().min(1)).min(1),
  tasks: z.array(TaskSchema).min(1),
});

type TaskLocator = { phaseIdx: number; taskIdx: number; depends_on: string[] };

const UNVISITED = 0;
const IN_STACK = 1;
const DONE = 2;

export const PhasesSchema = z
  .object({
    project: z.string().min(1),
    tracker_project_id: z.string().optional(),
    tracker_url: z.string().optional(),
    gate_check_command: z.string().optional(),
    phases: z.array(PhaseSchema).min(1),
  })
  .superRefine((data, ctx) => {
    const seenPhaseIds = new Map<string, number>();
    data.phases.forEach((phase, phaseIdx) => {
      if (seenPhaseIds.has(phase.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate phase id: ${phase.id}`,
          path: ['phases', phaseIdx, 'id'],
        });
        return;
      }
      seenPhaseIds.set(phase.id, phaseIdx);
    });

    const taskIndex = new Map<string, TaskLocator>();

    data.phases.forEach((phase, phaseIdx) => {
      phase.tasks.forEach((task, taskIdx) => {
        if (taskIndex.has(task.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate task id: ${task.id}`,
            path: ['phases', phaseIdx, 'tasks', taskIdx, 'id'],
          });
          return;
        }
        taskIndex.set(task.id, { phaseIdx, taskIdx, depends_on: task.depends_on });
      });
    });

    const phaseIds = new Set(data.phases.map((p) => p.id));
    data.phases.forEach((phase, phaseIdx) => {
      if (phase.blocked_by && !phaseIds.has(phase.blocked_by)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `blocked_by references unknown phase id: ${phase.blocked_by}`,
          path: ['phases', phaseIdx, 'blocked_by'],
        });
      }
    });

    for (const [taskId, info] of taskIndex) {
      for (const dep of info.depends_on) {
        if (!taskIndex.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `depends_on references unknown task id: ${dep} (from ${taskId})`,
            path: ['phases', info.phaseIdx, 'tasks', info.taskIdx, 'depends_on'],
          });
        }
      }
    }

    const color = new Map<string, number>();
    for (const id of taskIndex.keys()) color.set(id, UNVISITED);
    const reportedCycles = new Set<string>();

    const visit = (id: string, path: string[]): void => {
      color.set(id, IN_STACK);
      path.push(id);
      const info = taskIndex.get(id);
      if (info) {
        for (const dep of info.depends_on) {
          const depColor = color.get(dep);
          if (depColor === undefined) continue;
          if (depColor === IN_STACK) {
            const cycleStart = path.indexOf(dep);
            const cyclePath = path.slice(cycleStart).concat(dep);
            const key = cyclePath.join('>');
            if (!reportedCycles.has(key)) {
              reportedCycles.add(key);
              const firstInfo = taskIndex.get(cyclePath[0]!)!;
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `depends_on cycle detected: ${cyclePath.join(' -> ')}`,
                path: [
                  'phases',
                  firstInfo.phaseIdx,
                  'tasks',
                  firstInfo.taskIdx,
                  'depends_on',
                ],
              });
            }
            continue;
          }
          if (depColor === DONE) continue;
          visit(dep, path);
        }
      }
      color.set(id, DONE);
      path.pop();
    };

    for (const id of taskIndex.keys()) {
      if (color.get(id) === UNVISITED) visit(id, []);
    }
  });

export type Task = z.infer<typeof TaskSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type Phases = z.infer<typeof PhasesSchema>;
export type OwnerType = (typeof OWNER_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type TaskType = (typeof TASK_TYPES)[number];
export type Estimate = (typeof ESTIMATES)[number];
export type PhaseStatus = (typeof PHASE_STATUSES)[number];
