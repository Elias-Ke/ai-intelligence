import type { SqliteDatabase } from './database.js';
import { ErrorCodes } from '../domain/errorCodes.js';

export function recoverInterruptedScans(db: SqliteDatabase) {
  const timestamp = new Date().toISOString();
  return db.transaction(() => {
    const active = db.prepare("SELECT task_id taskId,discovered_count discoveredCount FROM scan_tasks WHERE status IN ('created','collecting','normalizing','clustering','analyzing','generating','retrying')").all() as { taskId: number; discoveredCount: number }[];
    for (const task of active) {
      db.prepare("UPDATE scan_task_steps SET status='failed',error_code=?,error_message='扫描被服务重启中断',finished_at=? WHERE task_id=? AND status='running'").run(ErrorCodes.INTERNAL, timestamp, task.taskId);
      db.prepare('UPDATE scan_tasks SET status=?,error_code=?,error_message=?,started_at=COALESCE(started_at,created_at),finished_at=?,heartbeat_at=? WHERE task_id=?').run(task.discoveredCount ? 'partial_failed' : 'failed', ErrorCodes.INTERNAL, '扫描被服务重启中断，可手动重试', timestamp, timestamp, task.taskId);
    }
    return active.map(({ taskId }) => taskId);
  })();
}
