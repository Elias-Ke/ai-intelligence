<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Compass, DataAnalysis, Document, FolderOpened, House, List, Plus, Refresh, Search, Star, TrendCharts } from '@element-plus/icons-vue';

type View = 'dashboard' | 'stream' | 'discoveries' | 'trends' | 'opportunities' | 'topics' | 'saved' | 'history' | 'sources';
type Signal = { signalId: number; title: string; summary: string; valueScore: number; evidenceLevel: string; evidenceCount?: number; eventAt?: string; isHighlighted?: number; publishedAtVerified?: number; tags?: string[]; sourceName?: string; saved?: number; ignored?: number; state?: string; valueRating?: number };
const view = ref<View>('dashboard');
const signals = ref<Signal[]>([]); const records = ref<Record<string, any>[]>([]); const loading = ref(false); const query = ref(''); const scanRange = ref('24h'); const scanStatus = ref(''); const activeTaskId = ref<number | null>(null);
const progress = ref(0); const discoveredCount = ref(0); const signalCount = ref(0); const opportunityCount = ref(0); const topicCount = ref(0); const sourceSuccessCount = ref(0); const sourceFailureCount = ref(0); const anysearchQueryCount = ref(0); const starting = ref(false);
const currentStep = ref(''); const stepItems = ref(0); const latestSignal = ref('');
const nextCursor = ref<string | null>(null); const details = ref<Record<string, any> | null>(null); const detailsLoading = ref(false);
const discoveryStatus = ref(''); const discoveryTaskId = ref<number | null>(null);
const selectedTaskId = ref<number | null>(null); const scanDates = ref<[Date, Date] | null>(null); const signalType = ref(''); const evidenceLevel = ref(''); const signalSort = ref('value');
const listStatus = ref(''); const platform = ref(''); const historyStatus = ref(''); const sourceKind = ref(''); const sourceGroup = ref(''); const savedTarget = ref<'signal' | 'opportunity' | 'content_topic'>('signal');
const sourceDialog = ref(false); const sourceSaving = ref(false); const sourceUrlError = ref('');
const capabilities = ref<{ anySearch: boolean; llm: boolean } | null>(null); const healthError = ref('');
const dashboardTrends = ref<Record<string, any>[]>([]); const dashboardOpportunities = ref<Record<string, any>[]>([]); const dashboardTopics = ref<Record<string, any>[]>([]);
const dashboardLoading = ref(false); const dashboardError = ref(''); const groupEnabled = ref(false); const groupTotal = ref(0); const groupActive = ref(0); const groupLoading = ref(false);
const lastRequestId = ref(''); let pendingScanKey: string | null = null;
const newSource = reactive({ name: '', sourceGroup: '新发现候选', kind: 'web', url: '', language: 'mixed', region: 'global', trustLevel: 1, enabled: false, fetchIntervalMinutes: 1440 });
let detailsVersion = 0;
const detailsOpen = computed({ get: () => details.value !== null, set: (open: boolean) => { if (!open) { detailsVersion++; details.value = null; detailsLoading.value = false; } } });
let eventSource: EventSource | null = null; let pollTimer: ReturnType<typeof setTimeout> | null = null; let listController: AbortController | null = null; let loadVersion = 0; let dashboardVersion = 0; let groupStateVersion = 0;
const nav = [{ key: 'dashboard', label: '今日扫描', icon: House }, { key: 'stream', label: '完整情报流', icon: DataAnalysis }, { key: 'trends', label: '趋势追踪', icon: TrendCharts }, { key: 'opportunities', label: '副业机会', icon: Compass }, { key: 'topics', label: '内容选题', icon: Document }, { key: 'saved', label: '收藏', icon: Star }, { key: 'history', label: '扫描历史', icon: List }, { key: 'sources', label: '来源库', icon: FolderOpened }] as const;
const title = computed(() => nav.find((item) => item.key === view.value)?.label ?? '原始发现库');

function endpoint() {
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | null) => { if (value !== '' && value !== null) params.set(key, String(value)); };
  let path = '/api/signals';
  if (view.value === 'dashboard') set('taskId', activeTaskId.value);
  else if (view.value === 'stream') { set('taskId', selectedTaskId.value); set('q', query.value); set('signalType', signalType.value); set('evidenceLevel', evidenceLevel.value); set('sort', signalSort.value); }
  else if (view.value === 'discoveries') { path = '/api/discoveries'; set('status', discoveryStatus.value); set('taskId', discoveryTaskId.value); }
  else if (view.value === 'saved') {
    path = savedTarget.value === 'signal' ? '/api/signals' : savedTarget.value === 'opportunity' ? '/api/opportunities' : '/api/content-topics';
    set('saved', 'true');
  } else if (view.value === 'trends') path = '/api/entities';
  else if (view.value === 'opportunities') { path = '/api/opportunities'; set('status', listStatus.value); }
  else if (view.value === 'topics') { path = '/api/content-topics'; set('status', listStatus.value); set('platform', platform.value); }
  else if (view.value === 'history') { path = '/api/scans'; set('status', historyStatus.value); }
  else if (view.value === 'sources') { path = '/api/sources'; set('kind', sourceKind.value); set('sourceGroup', sourceGroup.value); }
  return `${path}?${params}`;
}
async function loadView(more = false) {
  if (more && (loading.value || !nextCursor.value)) return;
  if (!more) { nextCursor.value = null; listController?.abort(); if (view.value === 'dashboard' || view.value === 'stream') signals.value = []; else records.value = []; if (view.value === 'dashboard') void loadDashboardHighlights(); if (view.value === 'sources') void loadGroupState(); }
  const version = ++loadVersion;
  const controller = new AbortController(); listController = controller;
  loading.value = true;
  try {
    const path = endpoint();
    if (view.value === 'dashboard') {
      if (!activeTaskId.value) return;
      const readSignals = async (url: string): Promise<Signal[]> => {
        const body = await (await fetch(url, { signal: controller.signal })).json();
        if (body.code !== 0) throw new Error(`${body.message}（${body.code}，${body.requestId}）`);
        return body.data.items;
      };
      const base = `${path}&state=active&ignored=false`;
      const highlighted = await readSignals(`${base}&highlighted=true&limit=5`);
      const remaining = highlighted.length < 5 ? await readSignals(`${base}&limit=10`) : [];
      if (version !== loadVersion) return;
      signals.value = [...highlighted, ...remaining.filter((item) => !highlighted.some((featured) => featured.signalId === item.signalId))].slice(0, 5);
      return;
    }
    const cursor = more && nextCursor.value ? `&cursor=${encodeURIComponent(nextCursor.value)}` : '';
    const response = await fetch(`${path}&limit=30${cursor}`, { signal: controller.signal });
    const body = await response.json();
    if (version !== loadVersion) return;
    if (body.code !== 0) throw new Error(`${body.message}（${body.code}，${body.requestId}）`);
    if (view.value === 'stream') signals.value = more ? [...signals.value, ...body.data.items] : body.data.items;
    else records.value = more ? [...records.value, ...body.data.items] : body.data.items;
    nextCursor.value = body.data.nextCursor;
  } catch (error) { if (version === loadVersion && !controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : '数据加载失败'); }
  finally { if (version === loadVersion) loading.value = false; }
}
function loadSignals() { return loadView(); }
async function loadDashboardHighlights() {
  const version = ++dashboardVersion;
  dashboardLoading.value = true; dashboardError.value = '';
  try {
    const results = await Promise.all(['/api/entities?followed=true&limit=3', '/api/opportunities?limit=3', '/api/content-topics?limit=3'].map(async (path) => {
      const body = await (await fetch(path)).json();
      if (body.code !== 0) throw new Error(`${body.message}（${body.code}，${body.requestId}）`);
      return body.data.items as Record<string, any>[];
    }));
    if (version === dashboardVersion && view.value === 'dashboard') [dashboardTrends.value, dashboardOpportunities.value, dashboardTopics.value] = results;
  } catch (error) { if (version === dashboardVersion && view.value === 'dashboard') dashboardError.value = error instanceof Error ? error.message : '概览获取失败'; }
  finally { if (version === dashboardVersion) dashboardLoading.value = false; }
}
async function fetchAllSources(filter: Record<string, string>) {
  const items: Record<string, any>[] = []; let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ ...filter, limit: '100' }); if (cursor) params.set('cursor', cursor);
    const body = await (await fetch(`/api/sources?${params}`)).json();
    if (body.code !== 0) throw new Error(`${body.message}（${body.code}，${body.requestId}）`);
    items.push(...body.data.items); cursor = body.data.nextCursor;
  } while (cursor);
  return items;
}
async function loadGroupState() {
  const group = sourceGroup.value;
  const version = ++groupStateVersion;
  groupTotal.value = 0; groupActive.value = 0; groupEnabled.value = false;
  if (!group) return;
  try {
    const rows = await fetchAllSources({ sourceGroup: group });
    if (version !== groupStateVersion || group !== sourceGroup.value) return;
    groupTotal.value = rows.length; groupActive.value = rows.filter((row) => Boolean(row.enabled)).length; groupEnabled.value = rows.length > 0 && groupActive.value === rows.length;
  } catch (error) { if (version === groupStateVersion) ElMessage.error(error instanceof Error ? error.message : '来源组状态获取失败'); }
}
async function loadHealth() {
  try {
    const body = await (await fetch('/api/system/health')).json();
    if (body.code !== 0) throw new Error(`${body.message}（错误码 ${body.code}，${body.requestId}）`);
    capabilities.value = body.data.capabilities; healthError.value = '';
  } catch (error) { capabilities.value = null; healthError.value = error instanceof Error ? error.message : '服务健康状态获取失败'; }
}
async function openDetails(type: 'signals' | 'opportunities' | 'content-topics' | 'entities' | 'scans', id: number) {
  const version = ++detailsVersion;
  details.value = { type, id }; detailsLoading.value = true;
  try {
    const taskQuery = type === 'signals' && view.value === 'stream' && selectedTaskId.value ? `?taskId=${selectedTaskId.value}` : '';
    const body = await (await fetch(`/api/${type}/${id}${taskQuery}`)).json();
    if (version !== detailsVersion) return;
    if (body.code !== 0) throw new Error(`${body.message}（${body.code}，${body.requestId}）`);
    details.value = { ...body.data, type, id };
  } catch (error) { if (version === detailsVersion) { details.value = null; ElMessage.error(error instanceof Error ? error.message : '详情加载失败'); } }
  finally { if (version === detailsVersion) detailsLoading.value = false; }
}
type TaskSnapshot = { taskId: number; status: string; currentStep?: string; progress: number; discoveredCount: number; signalCount: number; opportunityCount: number; contentTopicCount: number; sourceSuccessCount?: number; sourceFailureCount?: number; anysearchQueryCount?: number; errorCode?: number | null; errorMessage?: string | null };
const stepLabels: Record<string, string> = { collecting: '发现中', normalizing: '整理中', clustering: '去重聚类中', analyzing: '分析中', generating: '生成结果中', completed: '已完成', partial_failed: '部分完成', failed: '失败', created: '待开始' };
async function requestJson(path: string, method: 'POST' | 'PATCH' | 'PUT', payload: Record<string, unknown>, key?: string) {
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(payload) });
  const result = await response.json(); lastRequestId.value = result.requestId || '';
  if (result.code !== 0) throw new Error(`${result.message}（错误码 ${result.code}，${result.requestId}）`);
  return result.data;
}
function clearProgressConnection() { eventSource?.close(); eventSource = null; if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }
function updateTask(task: TaskSnapshot) {
  const alreadyDone = activeTaskId.value === task.taskId && ['completed', 'partial_failed', 'failed'].includes(scanStatus.value);
  activeTaskId.value = task.taskId; scanStatus.value = task.status; currentStep.value = task.currentStep ?? task.status; progress.value = task.progress;
  discoveredCount.value = task.discoveredCount; signalCount.value = task.signalCount; opportunityCount.value = task.opportunityCount; topicCount.value = task.contentTopicCount; sourceSuccessCount.value = task.sourceSuccessCount ?? 0; sourceFailureCount.value = task.sourceFailureCount ?? 0; anysearchQueryCount.value = task.anysearchQueryCount ?? 0;
  if (['completed', 'partial_failed', 'failed'].includes(task.status)) {
    clearProgressConnection(); if (view.value === 'dashboard') void loadView();
    if (!alreadyDone && task.status === 'completed') ElMessageBox.alert(`${task.discoveredCount} 条发现、${task.signalCount} 条信号、${task.opportunityCount} 个机会、${task.contentTopicCount} 个选题。`, '扫描完成', { confirmButtonText: '查看结果' });
    else if (!alreadyDone) ElMessageBox.confirm(`${task.errorMessage || '部分来源未能完成'}（错误码 ${task.errorCode || 100003}，${lastRequestId.value || '请查看扫描历史'}）。已保存的结果仍可查看。`, task.status === 'failed' ? '扫描失败' : '部分完成', { confirmButtonText: '查看已有结果', cancelButtonText: '留在当前页' }).then(() => go('stream')).catch(() => {});
  }
}
async function pollTask(id: number) {
  try { const response = await fetch(`/api/scans/${id}`); const body = await response.json(); if (body.code !== 0) throw new Error(`${body.message}（${body.code}，${body.requestId}）`); updateTask(body.data); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '任务状态获取失败'); }
  if (activeTaskId.value === id && !['completed', 'partial_failed', 'failed'].includes(scanStatus.value)) pollTimer = setTimeout(() => { void pollTask(id); }, 3000);
}
function subscribeTask(id: number) {
  clearProgressConnection();
  eventSource = new EventSource(`/api/scans/${id}/events`);
  for (const event of ['task_snapshot', 'task_completed', 'task_failed']) eventSource.addEventListener(event, (message) => updateTask(JSON.parse((message as MessageEvent).data) as TaskSnapshot));
  eventSource.addEventListener('step_progress', (message) => {
    const step = JSON.parse((message as MessageEvent).data) as { stepName: string; itemsDone: number; progress: number };
    currentStep.value = step.stepName; stepItems.value = step.itemsDone; progress.value = step.progress;
  });
  eventSource.addEventListener('signal_ready', (message) => { latestSignal.value = (JSON.parse((message as MessageEvent).data) as { title: string }).title; });
  eventSource.onerror = () => { clearProgressConnection(); void pollTask(id); };
}
async function restoreTask() {
  try { const response = await fetch('/api/scans?limit=1'); const body = await response.json(); const latest = body.data?.items?.[0] as TaskSnapshot | undefined; if (latest) { activeTaskId.value = latest.taskId; scanStatus.value = latest.status; currentStep.value = latest.currentStep ?? latest.status; progress.value = latest.progress; discoveredCount.value = latest.discoveredCount; signalCount.value = latest.signalCount; opportunityCount.value = latest.opportunityCount; topicCount.value = latest.contentTopicCount; sourceSuccessCount.value = latest.sourceSuccessCount ?? 0; sourceFailureCount.value = latest.sourceFailureCount ?? 0; anysearchQueryCount.value = latest.anysearchQueryCount ?? 0; if (view.value === 'dashboard') void loadView(); if (!['completed', 'partial_failed', 'failed'].includes(latest.status)) subscribeTask(latest.taskId); } }
  catch { /* The page still allows viewing previously loaded results. */ }
}
async function createScan() {
  if (starting.value) return;
  const custom = scanRange.value === 'custom' ? scanDates.value : null;
  if (scanRange.value === 'custom' && (!custom || !custom[0] || !custom[1] || custom[1].getTime() - custom[0].getTime() > 30 * 86400000)) { ElMessage.warning('请选择有效的起止时间，最长 30 天'); return; }
  try { await ElMessageBox.confirm(`扫描范围：${custom ? `${custom[0].toLocaleString()} 至 ${custom[1].toLocaleString()}` : scanRange.value === '24h' ? '过去 24 小时' : scanRange.value === '3d' ? '过去 3 天' : '过去 7 天'}；覆盖国内与国际公开来源。`, '开始新一轮扫描', { confirmButtonText: '开始扫描', cancelButtonText: '取消' }); } catch { return; }
  starting.value = true;
  try {
    pendingScanKey ??= `web-${crypto.randomUUID()}`;
    const data = await requestJson('/api/scans', 'POST', custom ? { range: 'custom', from: custom[0].toISOString(), to: custom[1].toISOString() } : { range: scanRange.value }, pendingScanKey);
    pendingScanKey = null; stepItems.value = 0; latestSignal.value = '';
    updateTask(data as TaskSnapshot); subscribeTask(data.taskId); ElMessage.success(data.reused ? '已连接到运行中的扫描' : '扫描任务已创建');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '扫描请求失败，请重试'); } finally { starting.value = false; }
}
async function toggleSource(row: Record<string, any>) {
  if (row.enabled) { try { await ElMessageBox.confirm(`停用 ${row.name} 后将不再采集该来源。`, '停用来源', { confirmButtonText: '停用', cancelButtonText: '取消' }); } catch { return; } }
  if (!row.enabled && row.sourceGroup === '新发现候选') { try { await ElMessageBox.confirm(`确认已核查 ${row.name} 的公开内容和来源可信度？`, '启用新发现来源', { confirmButtonText: '确认启用', cancelButtonText: '取消' }); } catch { return; } }
  try { const updated = await requestJson(`/api/sources/${row.sourceId}`, 'PATCH', { enabled: !Boolean(row.enabled) }); row.enabled = updated.enabled; ElMessage.success(row.enabled ? '来源已启用' : '来源已停用'); void loadGroupState(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '来源更新失败'); }
}
async function toggleSourceGroup(enabled: boolean) {
  const group = sourceGroup.value;
  if (!group || group === '新发现候选' || groupLoading.value) return;
  groupLoading.value = true; let changed = 0;
  try {
    const rows = await fetchAllSources({ sourceGroup: group });
    if (!enabled) {
      await ElMessageBox.confirm(`停用「${group}」中的 ${rows.filter((row) => row.enabled).length} 个来源？`, '停用来源组', { confirmButtonText: '停用', cancelButtonText: '取消' });
      if (!capabilities.value?.anySearch && (await fetchAllSources({ enabled: 'true' })).every((row) => row.sourceGroup === group)) throw new Error('至少需要保留一个可用来源或搜索配置（错误码 800003）');
    }
    for (const row of rows.filter((row) => Boolean(row.enabled) !== enabled)) { await requestJson(`/api/sources/${row.sourceId}`, 'PATCH', { enabled }); changed++; }
    ElMessage.success(`「${group}」已${enabled ? '启用' : '停用'} ${changed} 个来源`);
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(`${error instanceof Error ? error.message : '来源组更新失败'}${changed ? `；已更新 ${changed} 个来源，请重试剩余项` : ''}`); }
  finally { groupLoading.value = false; void loadView(); }
}
async function addSource() {
  sourceUrlError.value = '';
  if (!newSource.name.trim() || !newSource.url.trim()) { sourceUrlError.value = '请填写名称和公开 URL'; return; }
  sourceSaving.value = true;
  try { await requestJson('/api/sources', 'POST', { ...newSource }); sourceDialog.value = false; ElMessage.success('来源已添加'); void loadView(); }
  catch (error) { sourceUrlError.value = error instanceof Error ? error.message : '来源添加失败'; }
  finally { sourceSaving.value = false; }
}
async function updateItemState(row: Record<string, any>, type: 'signal' | 'opportunity' | 'content_topic', id: number, patch: Record<string, unknown>) {
  if (patch.ignored === true) { try { await ElMessageBox.confirm(`忽略「${row.title || details.value?.title || id}」？此操作可撤销。`, '忽略内容', { confirmButtonText: '忽略', cancelButtonText: '取消' }); } catch { return; } }
  const target = row.itemState ?? row;
  const previous = { saved: target.saved, ignored: target.ignored, valueRating: target.valueRating };
  const next = { ...patch, ...(patch.saved === true ? { ignored: false } : {}), ...(patch.ignored === true ? { saved: false } : {}) };
  Object.assign(target, next);
  try { Object.assign(target, await requestJson(`/api/item-states/${type}/${id}`, 'PUT', next)); ElMessage.success('已保存'); if ((view.value === 'saved' && next.saved === false) || (view.value === 'dashboard' && type === 'signal' && next.ignored === true)) void loadView(); }
  catch (error) { Object.assign(target, previous); ElMessage.error(error instanceof Error ? error.message : '保存失败'); }
}
function rateSignal(rating: number) { if (details.value) void updateItemState(details.value, 'signal', details.value.signalId, { valueRating: rating }); }
async function setCardStatus(row: Record<string, any>, type: 'opportunities' | 'content-topics', status: string) {
  try { row.status = (await requestJson(`/api/${type}/${type === 'opportunities' ? row.opportunityId : row.contentTopicId}/status`, 'PATCH', { status })).status; ElMessage.success('状态已更新'); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '状态更新失败'); }
}
async function followEntity(row: Record<string, any>) {
  try { row.followed = (await requestJson(`/api/entities/${row.entityId}/follow`, 'PUT', { followed: !Boolean(row.followed) })).followed; ElMessage.success(row.followed ? '已关注' : '已取消关注'); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '关注失败'); }
}
async function archiveSignal(row: Record<string, any>) {
  const next = row.state === 'archived' ? 'active' : 'archived';
  if (next === 'archived') { try { await ElMessageBox.confirm(`归档「${row.title}」后仍可从筛选中找回。`, '归档情报', { confirmButtonText: '归档', cancelButtonText: '取消' }); } catch { return; } }
  try { row.state = (await requestJson(`/api/signals/${row.signalId}/state`, 'PATCH', { state: next })).state; ElMessage.success(next === 'archived' ? '已归档' : '已恢复'); if (view.value === 'dashboard') void loadView(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '归档失败'); }
}
async function retryTask(row: Record<string, any>) {
  try { await ElMessageBox.confirm(`继续任务 #${row.taskId} 中未完成的步骤？`, '重试扫描', { confirmButtonText: '重试', cancelButtonText: '取消' }); }
  catch { return; }
  try { const task = await requestJson(`/api/scans/${row.taskId}/retry`, 'POST', {}, `retry-${crypto.randomUUID()}`); activeTaskId.value = task.taskId; go('dashboard'); subscribeTask(task.taskId); void pollTask(task.taskId); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '重试失败'); }
}
function go(next: View) { view.value = next; query.value = ''; nextCursor.value = null; records.value = []; if (next !== 'discoveries') discoveryTaskId.value = null; if (next !== 'stream') selectedTaskId.value = null; void loadView(); }
function showTaskResults(id: number, destination: 'stream' | 'discoveries') {
  view.value = destination; selectedTaskId.value = destination === 'stream' ? id : null; discoveryTaskId.value = destination === 'discoveries' ? id : null; void loadView();
}
onMounted(() => { void loadView(); void restoreTask(); void loadHealth(); });
onBeforeUnmount(() => { detailsVersion++; clearProgressConnection(); listController?.abort(); });
</script>

<template>
  <div class="workbench">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">S</div><div><strong>Signal</strong><span>AI 情报工作台</span></div></div>
      <div class="nav-group"><p>工作台</p><button v-for="item in nav.slice(0, 5)" :key="item.key" :class="{ active: view === item.key }" @click="go(item.key)"><el-icon><component :is="item.icon" /></el-icon><span>{{ item.label }}</span></button></div>
      <div class="nav-group"><p>资料库</p><button v-for="item in nav.slice(5)" :key="item.key" :class="{ active: view === item.key }" @click="go(item.key)"><el-icon><component :is="item.icon" /></el-icon><span>{{ item.label }}</span></button></div>
      <div class="sidebar-foot"><strong>单人工作台</strong>手动触发扫描，结果沉淀为个人判断库。</div>
    </aside>
    <main class="main">
      <header class="topbar"><div><div class="eyebrow">SIGNAL / AI INTELLIGENCE</div><h1>{{ title }}</h1><p>把 AI 前沿变化整理成可核查的信号、可验证的副业机会和可持续的内容选题。</p></div><div class="top-actions"><el-button :icon="Refresh" circle aria-label="刷新" @click="loadView(); loadHealth()" /><el-button type="primary" :icon="Plus" :loading="starting" @click="createScan">开始扫描</el-button></div></header>
      <el-alert v-if="healthError" :title="healthError" type="error" :closable="false" show-icon class="system-alert" />
      <el-alert v-else-if="capabilities && (!capabilities.anySearch || !capabilities.llm)" :title="`未就绪：${[!capabilities.anySearch && 'AnySearch 全网搜索', !capabilities.llm && '模型机会/选题生成'].filter(Boolean).join('、')}。请检查服务配置。`" type="warning" :closable="false" show-icon class="system-alert" />
      <section v-if="view === 'dashboard'" class="scan-panel">
        <div><h2>手动触发一轮情报扫描</h2></div>
        <div class="scan-controls"><el-select v-model="scanRange" style="width:150px"><el-option label="过去 24 小时" value="24h" /><el-option label="过去 3 天" value="3d" /><el-option label="过去 7 天" value="7d" /><el-option label="自定义" value="custom" /></el-select><el-date-picker v-if="scanRange === 'custom'" v-model="scanDates" type="datetimerange" range-separator="至" start-placeholder="开始时间" end-placeholder="结束时间" /><el-button type="primary" :icon="Search" :loading="starting" @click="createScan">开始扫描</el-button></div>
        <div class="scan-status"><span>当前任务</span><strong>{{ stepLabels[scanStatus] || stepLabels[currentStep] || '尚未运行' }}</strong><el-progress :percentage="progress" :show-text="false" /><small>{{ activeTaskId ? `任务 #${activeTaskId} · ${stepLabels[currentStep] || ''} · 已处理 ${stepItems}` : '暂无扫描任务' }}</small><small v-if="latestSignal">最新信号：{{ latestSignal }}</small></div>
      </section>
      <section class="stats"><article><span>本轮发现</span><strong>{{ activeTaskId ? discoveredCount : '--' }}</strong><small>已保存的原始条目</small></article><article><span>情报信号</span><strong>{{ activeTaskId ? signalCount : '--' }}</strong><small>需要核查证据</small></article><article><span>副业机会</span><strong>{{ activeTaskId ? opportunityCount : '--' }}</strong><small>达到门槛后生成</small></article><article><span>内容选题</span><strong>{{ activeTaskId ? topicCount : '--' }}</strong><small>事实可回溯</small></article><article><span>来源采集</span><strong>{{ activeTaskId ? `${sourceSuccessCount} 成功 / ${sourceFailureCount} 失败` : '--' }}</strong><small>单来源失败不会中断整轮</small></article><article><span>AnySearch 查询</span><strong>{{ activeTaskId ? anysearchQueryCount : '--' }}</strong><small>失败查询已隔离</small></article></section>
      <section v-if="view === 'dashboard' || view === 'stream'" class="content-panel">
        <div class="section-head"><div><h2>{{ view === 'dashboard' ? '本轮信号' : '完整情报流' }}</h2><span>按证据和价值排序</span></div><div class="section-actions"><el-button @click="go(view === 'dashboard' ? 'stream' : 'discoveries')">{{ view === 'dashboard' ? '完整情报流' : '原始发现' }}</el-button><el-input v-if="view === 'stream'" v-model="query" clearable placeholder="搜索主题、公司或技术" :prefix-icon="Search" @keyup.enter="loadView()" /></div></div>
        <div v-if="view === 'stream'" class="filters"><el-select v-model="signalType" placeholder="全部类型" clearable @change="loadView()"><el-option v-for="type in ['technology','product','paper','funding','company_action','use_case','open_source','market']" :key="type" :label="type" :value="type" /></el-select><el-select v-model="evidenceLevel" placeholder="证据等级" clearable @change="loadView()"><el-option v-for="level in ['single_source','multi_source','first_party','conflicting']" :key="level" :label="level" :value="level" /></el-select><el-segmented v-model="signalSort" :options="[{ label: '价值', value: 'value' }, { label: '最新', value: 'newest' }, { label: '证据', value: 'evidence' }]" @change="loadView()" /></div>
        <el-skeleton v-if="loading && !signals.length" :rows="5" animated /><el-empty v-else-if="!signals.length" description="暂无可核查信号"><el-button @click="go('discoveries')">查看原始发现</el-button></el-empty>
        <div v-else class="signal-list"><article v-for="signal in (view === 'dashboard' ? signals.slice(0, 5) : signals)" :key="signal.signalId" class="signal"><div class="signal-top"><span class="source">{{ signal.sourceName || '来源待核查' }} · {{ signal.publishedAtVerified === 0 ? '时间待核查' : signal.eventAt || '时间待核查' }}</span><el-tag type="success">价值 {{ signal.valueScore }}</el-tag></div><h3>{{ signal.title }}</h3><p>{{ signal.summary }}</p><div class="tags"><el-tag v-if="signal.isHighlighted" size="small" type="success">重点</el-tag><el-tag v-for="tag in signal.tags || []" :key="tag" size="small">{{ tag }}</el-tag><el-tag size="small" type="info">{{ signal.evidenceCount ?? 0 }} 条证据</el-tag><el-tag size="small" type="warning">{{ signal.evidenceLevel }}</el-tag><el-tag v-if="signal.publishedAtVerified === 0" size="small" type="warning">时间待核查</el-tag></div><footer><span>#{{ signal.signalId }}</span><div class="record-actions"><el-button :icon="Star" circle :type="signal.saved ? 'warning' : 'default'" title="收藏" @click="updateItemState(signal, 'signal', signal.signalId, { saved: !Boolean(signal.saved) })" /><el-button text type="primary" @click="openDetails('signals', signal.signalId)">查看分析</el-button></div></footer></article></div>
        <div v-if="view === 'stream' && nextCursor" class="load-more"><el-button :loading="loading" @click="loadView(true)">加载更多</el-button></div>
      </section>
      <section v-else-if="view === 'discoveries'" class="content-panel"><div class="section-head"><div><h2>原始发现库</h2><span>待核查的发现也会保留</span></div><div class="section-actions"><el-select v-model="discoveryStatus" placeholder="全部状态" clearable style="width:150px" @change="loadView()"><el-option label="候选" value="candidate" /><el-option label="已分析" value="accepted" /><el-option label="范围外" value="rejected" /><el-option label="提取失败" value="extract_failed" /></el-select><el-button @click="go('stream')">返回情报流</el-button></div></div><el-skeleton v-if="loading && !records.length" :rows="5" animated /><el-empty v-else-if="!records.length" description="暂无发现" /><div v-else class="record-list"><article v-for="row in records" :key="row.discoveryId" class="record"><div><span class="record-kicker">{{ row.sourceName || '全网发现' }} · {{ row.publishedAt || '时间待核查' }}</span><h3>{{ row.title }}</h3><p>{{ row.snippet }}</p></div><div class="record-actions"><el-tag :type="row.status === 'accepted' ? 'success' : 'warning'">{{ row.status }}</el-tag><el-button tag="a" :href="row.url" target="_blank" rel="noopener noreferrer" text type="primary">原文</el-button></div></article></div><div v-if="nextCursor" class="load-more"><el-button :loading="loading" @click="loadView(true)">加载更多</el-button></div></section>
      <section v-else class="content-panel">
        <div class="section-head"><div><h2>{{ title }}</h2><span v-if="view === 'sources'">{{ sourceGroup === '新发现候选' ? '新域名默认停用，审核后再启用' : '高质量来源与全网新发现' }}</span><span v-else-if="view === 'history'">历史任务及已保存的结果</span></div><div class="section-actions"><el-button v-if="view === 'sources'" type="primary" :icon="Plus" @click="sourceDialog = true">添加来源</el-button><el-button :icon="Refresh" @click="loadView()">刷新</el-button></div></div>
        <div class="filters" v-if="view === 'opportunities' || view === 'topics'"><el-select v-model="listStatus" placeholder="全部状态" clearable @change="loadView()"><el-option v-for="status in (view === 'opportunities' ? ['candidate','prepare_verification','verified'] : ['candidate','preparing','published'])" :key="status" :label="status" :value="status" /></el-select><el-select v-if="view === 'topics'" v-model="platform" placeholder="全部平台" clearable @change="loadView()"><el-option v-for="site in ['wechat','video_account','xiaohongshu','zhihu','bilibili','douyin','x','newsletter']" :key="site" :label="site" :value="site" /></el-select></div>
        <div class="filters" v-if="view === 'saved'"><el-segmented v-model="savedTarget" :options="[{ label: '情报', value: 'signal' }, { label: '副业机会', value: 'opportunity' }, { label: '内容选题', value: 'content_topic' }]" @change="loadView()" /></div>
        <div class="filters" v-if="view === 'history'"><el-select v-model="historyStatus" placeholder="全部任务" clearable @change="loadView()"><el-option v-for="status in ['created','collecting','normalizing','clustering','analyzing','generating','completed','partial_failed','failed']" :key="status" :label="stepLabels[status] || status" :value="status" /></el-select></div>
        <div class="filters" v-if="view === 'sources'"><el-select v-model="sourceGroup" placeholder="全部来源组" clearable @change="loadView()"><el-option v-for="group in ['国际官方','国内官方','研究开源','科技媒体','新发现候选']" :key="group" :label="group" :value="group" /></el-select><el-select v-model="sourceKind" placeholder="全部类型" clearable @change="loadView()"><el-option v-for="kind in ['rss','api','web']" :key="kind" :label="kind" :value="kind" /></el-select><span v-if="sourceGroup" class="group-toggle"><span>启用来源组 · {{ groupActive }}/{{ groupTotal }}</span><el-tooltip :content="sourceGroup === '新发现候选' ? '新发现来源需逐条审核启用' : '启用或停用当前来源组'" placement="top"><span><el-switch :model-value="groupEnabled" :loading="groupLoading" :disabled="sourceGroup === '新发现候选' || groupTotal === 0" @change="toggleSourceGroup" /></span></el-tooltip></span></div>
        <el-skeleton v-if="loading && !records.length" :rows="5" animated /><el-empty v-else-if="!records.length" :description="`${title}暂无结果`"><el-button v-if="view !== 'sources'" type="primary" @click="go('dashboard')">今日扫描</el-button></el-empty>
        <div v-else class="record-list"><article v-for="row in records" :key="row.sourceId || row.entityId || row.opportunityId || row.contentTopicId || row.taskId || row.signalId" class="record"><div><span class="record-kicker">{{ view === 'sources' ? row.sourceGroup : view === 'history' ? `任务 #${row.taskId}` : view === 'trends' ? row.entityType : view === 'opportunities' ? '副业机会' : view === 'topics' ? '内容选题' : '情报' }}</span><h3>{{ row.name || row.title || row.coreViewpoint || `扫描任务 ${row.taskId}` }}</h3><p v-if="view === 'sources'">{{ row.lastErrorReason ? `最近失败：${row.lastErrorReason}` : row.lastSuccessAt ? `最近成功：${row.lastSuccessAt}` : '尚未采集' }}</p><p v-else>{{ row.summary || row.coreViewpoint || (view === 'history' ? `${row.discoveredCount ?? 0} 条发现 · ${row.signalCount ?? 0} 条信号 · ${row.sourceSuccessCount ?? 0} 个来源成功 · ${row.sourceFailureCount ?? 0} 个来源失败` : row.url || '') }}</p></div>
          <div class="record-actions"><el-tag v-if="view === 'sources'" :type="row.lastErrorReason ? 'danger' : row.enabled ? 'success' : 'info'">{{ row.lastErrorReason ? '采集异常' : row.enabled ? '已启用' : '已停用' }}</el-tag><el-tag v-else>{{ stepLabels[row.status] || row.status || row.evidenceLevel || '可查看' }}</el-tag>
            <el-button v-if="view === 'sources'" text type="primary" @click="toggleSource(row)">{{ row.enabled ? '停用' : '启用' }}</el-button>
            <template v-else-if="view === 'history'"><el-button text @click="openDetails('scans', row.taskId)">任务详情</el-button><el-button text type="primary" @click="showTaskResults(row.taskId, 'stream')">查看结果</el-button><el-button v-if="row.status === 'failed' || row.status === 'partial_failed'" text type="warning" @click="retryTask(row)">重试</el-button></template>
            <template v-else-if="view === 'trends'"><el-button :icon="Star" circle :type="row.followed ? 'warning' : 'default'" :title="row.followed ? '取消关注' : '关注'" @click="followEntity(row)" /><el-button text type="primary" @click="openDetails('entities', row.entityId)">时间线</el-button></template>
            <template v-else><el-button :icon="Star" circle :type="row.saved ? 'warning' : 'default'" title="收藏" @click="updateItemState(row, row.opportunityId ? 'opportunity' : row.contentTopicId ? 'content_topic' : 'signal', row.opportunityId || row.contentTopicId || row.signalId, { saved: !Boolean(row.saved) })" /><el-select v-if="row.opportunityId || row.contentTopicId" :model-value="row.status" size="small" class="status-select" @change="(value: string) => setCardStatus(row, row.opportunityId ? 'opportunities' : 'content-topics', value)"><el-option v-for="status in (row.opportunityId ? ['candidate','prepare_verification','verified'] : ['candidate','preparing','published'])" :key="status" :label="status" :value="status" /></el-select><el-button text type="primary" @click="openDetails(row.opportunityId ? 'opportunities' : row.contentTopicId ? 'content-topics' : 'signals', row.opportunityId || row.contentTopicId || row.signalId)">查看详情</el-button></template>
          </div></article></div><div v-if="nextCursor" class="load-more"><el-button :loading="loading" @click="loadView(true)">加载更多</el-button></div>
      </section>
      <section v-if="view === 'dashboard'" class="dashboard-extras">
        <el-alert v-if="dashboardError" :title="dashboardError" type="error" show-icon @close="dashboardError = ''" />
        <div class="dashboard-column"><div class="dashboard-column-head"><h2>关注趋势</h2><el-button text type="primary" @click="go('trends')">查看全部</el-button></div><el-skeleton v-if="dashboardLoading" :rows="3" animated /><el-empty v-else-if="!dashboardTrends.length" description="暂无关注趋势" /><button v-for="row in dashboardTrends" :key="row.entityId" class="dashboard-row" @click="openDetails('entities', row.entityId)"><strong>{{ row.name }}</strong><small>{{ row.signalCount }} 条信号 · {{ row.latestEvent?.headline || '暂无事件' }}</small></button></div>
        <div class="dashboard-column"><div class="dashboard-column-head"><h2>副业机会</h2><el-button text type="primary" @click="go('opportunities')">查看全部</el-button></div><el-skeleton v-if="dashboardLoading" :rows="3" animated /><el-empty v-else-if="!dashboardOpportunities.length" description="暂无机会" /><button v-for="row in dashboardOpportunities" :key="row.opportunityId" class="dashboard-row" @click="openDetails('opportunities', row.opportunityId)"><strong>{{ row.title }}</strong><small>{{ row.summary }}</small></button></div>
        <div class="dashboard-column"><div class="dashboard-column-head"><h2>内容选题</h2><el-button text type="primary" @click="go('topics')">查看全部</el-button></div><el-skeleton v-if="dashboardLoading" :rows="3" animated /><el-empty v-else-if="!dashboardTopics.length" description="暂无选题" /><button v-for="row in dashboardTopics" :key="row.contentTopicId" class="dashboard-row" @click="openDetails('content-topics', row.contentTopicId)"><strong>{{ row.title }}</strong><small>{{ row.coreViewpoint }}</small></button></div>
      </section>
      <el-drawer v-model="detailsOpen" :title="details?.title || details?.name || `任务 #${details?.taskId || ''}`" size="min(560px, 100%)" :with-header="true">
        <el-skeleton v-if="detailsLoading" :rows="7" animated />
        <div v-else-if="details" class="detail-body">
          <p>{{ details.summary || details.coreViewpoint }}</p>
          <div class="detail-actions" v-if="details.type === 'signals'"><el-button :icon="Star" @click="updateItemState(details, 'signal', details.signalId, { saved: !Boolean(details.itemState?.saved) })">{{ details.itemState?.saved ? '取消收藏' : '收藏' }}</el-button><el-button @click="updateItemState(details, 'signal', details.signalId, { ignored: !Boolean(details.itemState?.ignored) })">{{ details.itemState?.ignored ? '取消忽略' : '忽略' }}</el-button><el-button @click="archiveSignal(details)">{{ details.state === 'archived' ? '恢复' : '归档' }}</el-button></div>
          <div class="detail-actions" v-if="details.type === 'signals'"><span>价值反馈</span><el-segmented :model-value="details.itemState?.valueRating || 0" :options="[{ label: '无价值', value: -1 }, { label: '未评价', value: 0 }, { label: '有价值', value: 1 }]" @change="rateSignal" /></div>
          <div class="detail-actions" v-if="details.type === 'opportunities' || details.type === 'content-topics'"><el-select :model-value="details.status" class="status-select" @change="(status: string) => setCardStatus(details!, details!.type, status)"><el-option v-for="status in (details.type === 'opportunities' ? ['candidate','prepare_verification','verified'] : ['candidate','preparing','published'])" :key="status" :label="status" :value="status" /></el-select></div>
          <div class="detail-actions" v-if="details.type === 'entities'"><el-button :icon="Star" @click="followEntity(details)">{{ details.followed ? '取消关注' : '关注趋势' }}</el-button></div>
          <el-descriptions v-if="details.type !== 'scans' && details.type !== 'entities'" :column="1" border size="small"><el-descriptions-item label="价值分">{{ details.valueScore ?? details.evidenceScore }}</el-descriptions-item><el-descriptions-item v-if="details.evidenceLevel" label="证据等级">{{ details.evidenceLevel }}</el-descriptions-item><el-descriptions-item v-if="details.validationAction" label="验证动作">{{ details.validationAction }}</el-descriptions-item><el-descriptions-item v-if="details.technologyChange" label="技术变化">{{ details.technologyChange }}</el-descriptions-item></el-descriptions>
          <template v-if="details.type === 'opportunities'"><h3>需求与切入点</h3><el-descriptions :column="1" border size="small"><el-descriptions-item label="目标用户">{{ details.targetUsers }}</el-descriptions-item><el-descriptions-item label="用户问题">{{ details.problem }}</el-descriptions-item><el-descriptions-item label="机会时机">{{ details.timingReason }}</el-descriptions-item><el-descriptions-item label="产品 / 服务形态">{{ details.solutionForm }}</el-descriptions-item><el-descriptions-item label="交付难度">{{ details.deliveryDifficulty }}</el-descriptions-item><el-descriptions-item label="获客难度">{{ details.acquisitionDifficulty }}</el-descriptions-item><el-descriptions-item label="变现方式">{{ details.monetization }}</el-descriptions-item><el-descriptions-item label="预期周期">{{ details.paybackPeriod }}</el-descriptions-item></el-descriptions><template v-if="details.alternatives?.length"><h3>现有替代方案</h3><ul class="detail-list"><li v-for="alternative in details.alternatives" :key="alternative">{{ alternative }}</li></ul></template></template>
          <template v-if="details.type === 'content-topics'"><h3>事实与背景</h3><p v-if="details.background">{{ details.background }}</p><ul v-if="details.coreFacts?.length" class="detail-list"><li v-for="fact in details.coreFacts" :key="fact">{{ fact }}</li></ul><template v-if="details.useCases?.length"><h3>落地案例</h3><ul class="detail-list"><li v-for="caseItem in details.useCases" :key="caseItem">{{ caseItem }}</li></ul></template><template v-if="details.arguments?.length"><h3>可表达观点</h3><ul class="detail-list"><li v-for="argument in details.arguments" :key="argument">{{ argument }}</li></ul></template><template v-if="details.controversies?.length"><h3>争议与反证</h3><ul class="detail-list"><li v-for="controversy in details.controversies" :key="controversy">{{ controversy }}</li></ul></template></template>
          <template v-if="details.scoreExplanation"><h3>评分依据</h3><p v-for="(reason, dimension) in details.scoreExplanation" :key="dimension"><strong>{{ dimension }}</strong>：{{ reason }}</p></template>
          <template v-if="details.type === 'scans'"><el-descriptions :column="1" border><el-descriptions-item label="状态">{{ stepLabels[details.status] || details.status }}</el-descriptions-item><el-descriptions-item label="原始发现">{{ details.discoveredCount }}</el-descriptions-item><el-descriptions-item label="情报信号">{{ details.signalCount }}</el-descriptions-item><el-descriptions-item label="来源采集">{{ details.sourceSuccessCount ?? 0 }} 成功 / {{ details.sourceFailureCount ?? 0 }} 失败</el-descriptions-item><el-descriptions-item label="AnySearch 查询">{{ details.anysearchQueryCount ?? 0 }}</el-descriptions-item><el-descriptions-item v-if="details.status === 'partial_failed'" label="可用结果">已有结果，部分来源失败，可查看已有结果或重试失败步骤</el-descriptions-item><el-descriptions-item v-if="details.errorCode" label="错误">{{ details.errorMessage }}（{{ details.errorCode }}，{{ lastRequestId || '请求 ID 见扫描历史' }}）</el-descriptions-item></el-descriptions><h3>执行步骤</h3><el-timeline><el-timeline-item v-for="step in details.steps || []" :key="step.stepName" :timestamp="step.finishedAt || step.startedAt || ''"><strong>{{ stepLabels[step.stepName] || step.stepName }}</strong> · {{ stepLabels[step.status] || step.status }} · {{ step.itemsDone }}/{{ step.itemsTotal }}<p v-if="step.errorCode">{{ step.errorMessage }}（{{ step.errorCode }}）</p></el-timeline-item></el-timeline><div class="detail-actions"><el-button @click="detailsOpen = false; showTaskResults(details!.taskId, 'stream')">查看信号</el-button><el-button @click="detailsOpen = false; showTaskResults(details!.taskId, 'discoveries')">查看原始发现</el-button><el-button v-if="['failed','partial_failed'].includes(details.status)" type="primary" @click="retryTask(details!)">重试任务</el-button></div></template>
          <template v-if="details.type === 'entities'"><h3>事件时间线</h3><el-empty v-if="!details.events?.items?.length" description="暂无事件" /><el-timeline v-else><el-timeline-item v-for="event in details.events.items" :key="event.signalId" :timestamp="event.eventAt"><el-button text type="primary" @click="openDetails('signals', event.signalId)">{{ event.headline || event.signalTitle }}</el-button><p>{{ event.eventType }} · 价值 {{ event.valueScore }} · {{ event.evidenceLevel }}</p></el-timeline-item></el-timeline></template>
          <template v-if="details.type === 'signals' || details.type === 'opportunities' || details.type === 'content-topics'"><h3>证据来源</h3><el-empty v-if="!details.evidence?.length" description="暂无可回溯证据" /><ul v-else class="evidence-list"><li v-for="source in details.evidence" :key="source.discoveryId"><a :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title || source.url }}</a><small>{{ source.sourceName || source.url }} · {{ source.relationType || '支持' }}</small></li></ul></template>
          <template v-if="details.risks?.length"><h3>风险</h3><p v-for="risk in details.risks" :key="risk">{{ risk }}</p></template>
          <template v-if="details.openQuestions?.length"><h3>待确认</h3><p v-for="question in details.openQuestions" :key="question">{{ question }}</p></template>
          <template v-if="details.uncertainties?.length"><h3>不确定性</h3><p v-for="item in details.uncertainties" :key="item">{{ item }}</p></template>
          <template v-if="details.platformAngles"><h3>平台角度</h3><p v-for="(angle, platform) in details.platformAngles" :key="platform"><strong>{{ platform }}</strong>：{{ angle }}</p></template>
        </div>
      </el-drawer>
      <el-dialog v-model="sourceDialog" title="添加情报来源" width="min(520px, 96vw)" :close-on-click-modal="false"><el-form label-position="top" @submit.prevent="addSource"><el-form-item label="来源名称" required><el-input v-model="newSource.name" maxlength="100" show-word-limit /></el-form-item><el-form-item label="公开 URL" required :error="sourceUrlError"><el-input v-model="newSource.url" placeholder="https://" /></el-form-item><el-form-item label="来源组" required><el-input v-model="newSource.sourceGroup" maxlength="50" /></el-form-item><div class="source-fields"><el-form-item label="来源类型"><el-select v-model="newSource.kind"><el-option label="RSS" value="rss" /><el-option label="公开 API" value="api" /><el-option label="网页" value="web" /></el-select></el-form-item><el-form-item label="语言"><el-select v-model="newSource.language"><el-option label="中文" value="zh-CN" /><el-option label="英文" value="en" /><el-option label="混合" value="mixed" /></el-select></el-form-item><el-form-item label="地区"><el-select v-model="newSource.region"><el-option label="国内" value="cn" /><el-option label="国际" value="intl" /><el-option label="全球" value="global" /></el-select></el-form-item><el-form-item label="信任等级"><el-input-number v-model="newSource.trustLevel" :min="1" :max="5" /></el-form-item><el-form-item label="采集间隔（分钟）"><el-input-number v-model="newSource.fetchIntervalMinutes" :min="5" /></el-form-item></div><el-form-item label="启用来源"><el-switch v-model="newSource.enabled" /></el-form-item></el-form><template #footer><el-button @click="sourceDialog = false">取消</el-button><el-button type="primary" :loading="sourceSaving" @click="addSource">保存来源</el-button></template></el-dialog>
    </main>
  </div>
</template>
