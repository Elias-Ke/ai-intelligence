<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Compass, DataAnalysis, Document, FolderOpened, House, List, Plus, Refresh, Search, Star, TrendCharts } from '@element-plus/icons-vue';

type View = 'dashboard' | 'stream' | 'trends' | 'opportunities' | 'topics' | 'saved' | 'history' | 'sources';
type Signal = { signalId: number; title: string; summary: string; valueScore: number; evidenceLevel: string; tags?: string[]; sourceName?: string };
const view = ref<View>('dashboard');
const signals = ref<Signal[]>([]); const records = ref<Record<string, any>[]>([]); const loading = ref(false); const query = ref(''); const scanRange = ref('24h'); const scanStatus = ref(''); const activeTaskId = ref<number | null>(null);
const progress = ref(0); const discoveredCount = ref(0); const signalCount = ref(0); const opportunityCount = ref(0); const topicCount = ref(0); const starting = ref(false);
const nextCursor = ref<string | null>(null); const details = ref<Record<string, any> | null>(null); const detailsLoading = ref(false);
const detailsOpen = computed({ get: () => details.value !== null, set: (open: boolean) => { if (!open) details.value = null; } });
let eventSource: EventSource | null = null; let pollTimer: ReturnType<typeof setTimeout> | null = null;
const nav = [{ key: 'dashboard', label: '今日扫描', icon: House }, { key: 'stream', label: '完整情报流', icon: DataAnalysis }, { key: 'trends', label: '趋势追踪', icon: TrendCharts }, { key: 'opportunities', label: '副业机会', icon: Compass }, { key: 'topics', label: '内容选题', icon: Document }, { key: 'saved', label: '收藏', icon: Star }, { key: 'history', label: '扫描历史', icon: List }, { key: 'sources', label: '来源库', icon: FolderOpened }] as const;
const title = computed(() => nav.find((item) => item.key === view.value)?.label ?? '今日扫描');

function endpoint() {
  if (view.value === 'dashboard' || view.value === 'stream' || view.value === 'saved') return `/api/signals${view.value === 'saved' ? '?saved=true' : view.value === 'stream' && query.value ? `?q=${encodeURIComponent(query.value)}` : ''}`;
  const paths: Record<string, string> = { trends: '/api/entities', opportunities: '/api/opportunities', topics: '/api/content-topics', history: '/api/scans', sources: '/api/sources' };
  return paths[view.value];
}
async function loadView(more = false) {
  if (loading.value) return;
  loading.value = true;
  try {
    const path = endpoint();
    const cursor = more && nextCursor.value ? `&cursor=${encodeURIComponent(nextCursor.value)}` : '';
    const response = await fetch(`${path}${path.includes('?') ? '&' : '?'}limit=30${cursor}`);
    const body = await response.json();
    if (body.code !== 0) throw new Error(`${body.message}（${body.code}，${body.requestId}）`);
    if (view.value === 'dashboard' || view.value === 'stream') signals.value = more ? [...signals.value, ...body.data.items] : body.data.items;
    else records.value = more ? [...records.value, ...body.data.items] : body.data.items;
    nextCursor.value = body.data.nextCursor;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '数据加载失败'); }
  finally { loading.value = false; }
}
function loadSignals() { return loadView(); }
async function openDetails(type: 'signals' | 'opportunities' | 'content-topics', id: number) {
  details.value = { type, id }; detailsLoading.value = true;
  try {
    const body = await (await fetch(`/api/${type}/${id}`)).json();
    if (body.code !== 0) throw new Error(`${body.message}（${body.code}，${body.requestId}）`);
    details.value = { ...body.data, type, id };
  } catch (error) { details.value = null; ElMessage.error(error instanceof Error ? error.message : '详情加载失败'); }
  finally { detailsLoading.value = false; }
}
type TaskSnapshot = { taskId: number; status: string; progress: number; discoveredCount: number; signalCount: number; opportunityCount: number; contentTopicCount: number; errorCode?: number | null; errorMessage?: string | null };
function clearProgressConnection() { eventSource?.close(); eventSource = null; if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }
function updateTask(task: TaskSnapshot) {
  activeTaskId.value = task.taskId; scanStatus.value = task.status; progress.value = task.progress;
  discoveredCount.value = task.discoveredCount; signalCount.value = task.signalCount; opportunityCount.value = task.opportunityCount; topicCount.value = task.contentTopicCount;
  if (['completed', 'partial_failed', 'failed'].includes(task.status)) {
    clearProgressConnection(); void loadSignals();
    if (task.status === 'completed') ElMessage.success(`扫描完成：${task.discoveredCount} 条发现，${task.signalCount} 条信号`);
    else ElMessageBox.alert(`${task.errorMessage || '部分来源未能完成'}${task.errorCode ? `（错误码 ${task.errorCode}）` : ''}。已保存的结果仍可查看。`, task.status === 'failed' ? '扫描失败' : '部分完成', { confirmButtonText: '查看已有结果' });
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
  eventSource.onerror = () => { clearProgressConnection(); void pollTask(id); };
}
async function restoreTask() {
  try { const response = await fetch('/api/scans?limit=1'); const body = await response.json(); const latest = body.data?.items?.[0] as TaskSnapshot | undefined; if (latest) { updateTask(latest); if (!['completed', 'partial_failed', 'failed'].includes(latest.status)) subscribeTask(latest.taskId); } }
  catch { /* The page still allows viewing previously loaded results. */ }
}
async function createScan() {
  if (starting.value) return;
  try { await ElMessageBox.confirm(`扫描范围：${scanRange.value === '24h' ? '过去 24 小时' : scanRange.value === '3d' ? '过去 3 天' : '过去 7 天'}，将同时执行来源库和全网发现。`, '开始新一轮扫描', { confirmButtonText: '开始扫描', cancelButtonText: '取消' }); } catch { return; }
  starting.value = true;
  try {
    const key = `web-${crypto.randomUUID()}`; const response = await fetch('/api/scans', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ range: scanRange.value }) }); const body = await response.json();
    if (body.code !== 0) { ElMessage.error(`${body.message}（${body.code}，${body.requestId}）`); return; }
    updateTask(body.data as TaskSnapshot); subscribeTask(body.data.taskId); ElMessage.success(body.data.reused ? '已连接到运行中的扫描' : '扫描任务已创建');
  } catch { ElMessage.error('扫描请求失败，请重试'); } finally { starting.value = false; }
}
async function toggleSource(row: Record<string, any>) { const response = await fetch(`/api/sources/${row.sourceId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !Boolean(row.enabled) }) }); const body = await response.json(); if (body.code !== 0) { ElMessage.error(`${body.message}（${body.code}）`); return; } row.enabled = body.data.enabled; ElMessage.success(row.enabled ? '来源已启用' : '来源已停用'); }
function go(next: View) { view.value = next; query.value = ''; nextCursor.value = null; void loadView(); }
onMounted(() => { void loadView(); void restoreTask(); });
onBeforeUnmount(clearProgressConnection);
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
      <header class="topbar"><div><div class="eyebrow">SIGNAL / AI INTELLIGENCE</div><h1>{{ title }}</h1><p>把 AI 前沿变化整理成可核查的信号、可验证的副业机会和可持续的内容选题。</p></div><div class="top-actions"><el-button :icon="Refresh" circle aria-label="刷新" @click="loadView()" /><el-button type="primary" :icon="Plus" :loading="starting" @click="createScan">开始扫描</el-button></div></header>
      <section v-if="view === 'dashboard'" class="scan-panel"><div><h2>手动触发一轮情报扫描</h2><p>来源库保证稳定，全网发现负责找新信号。任务运行在当前 Node.js 进程中。</p></div><div class="scan-controls"><el-select v-model="scanRange" style="width:150px"><el-option label="过去 24 小时" value="24h" /><el-option label="过去 3 天" value="3d" /><el-option label="过去 7 天" value="7d" /></el-select><el-button type="primary" :icon="Search" :loading="starting" @click="createScan">开始扫描</el-button></div><div class="scan-status"><span>当前任务</span><strong>{{ scanStatus || '尚未运行' }}</strong><el-progress :percentage="progress" :show-text="false" /><small>{{ activeTaskId ? `任务 #${activeTaskId}` : '暂无扫描任务' }}</small></div></section>
      <section class="stats"><article><span>本轮发现</span><strong>{{ activeTaskId ? discoveredCount : '--' }}</strong><small>已保存的原始条目</small></article><article><span>情报信号</span><strong>{{ activeTaskId ? signalCount : '--' }}</strong><small>需要核查证据</small></article><article><span>副业机会</span><strong>{{ activeTaskId ? opportunityCount : '--' }}</strong><small>达到门槛后生成</small></article><article><span>内容选题</span><strong>{{ activeTaskId ? topicCount : '--' }}</strong><small>事实可回溯</small></article></section>
      <section v-if="view === 'dashboard' || view === 'stream'" class="content-panel"><div class="section-head"><div><h2>{{ view === 'dashboard' ? '本轮信号' : '完整情报流' }}</h2><span>按证据和价值排序</span></div><el-input v-if="view === 'stream'" v-model="query" clearable placeholder="搜索主题、公司或技术" :prefix-icon="Search" @keyup.enter="loadSignals" /></div><el-skeleton v-if="loading && !signals.length" :rows="5" animated /><el-empty v-else-if="!signals.length" description="暂无可核查信号，可查看原始发现" /><div v-else class="signal-list"><article v-for="signal in signals" :key="signal.signalId" class="signal"><div class="signal-top"><span class="source">{{ signal.sourceName || '待核查信号' }}</span><el-tag type="success">价值 {{ signal.valueScore }}</el-tag></div><h3>{{ signal.title }}</h3><p>{{ signal.summary }}</p><div class="tags"><el-tag v-for="tag in signal.tags || []" :key="tag" size="small">{{ tag }}</el-tag><el-tag size="small" type="warning">{{ signal.evidenceLevel }}</el-tag></div><footer><span>#{{ signal.signalId }}</span><el-button text type="primary" @click="openDetails('signals', signal.signalId)">查看详情</el-button></footer></article></div><div v-if="nextCursor" class="load-more"><el-button :loading="loading" @click="loadView(true)">加载更多</el-button></div></section>
      <section v-else class="content-panel"><div class="section-head"><div><h2>{{ title }}</h2><span>数据来自已完成扫描和当前持久化状态</span></div><el-button :icon="Refresh" @click="loadView()">刷新</el-button></div><el-skeleton v-if="loading && !records.length" :rows="5" animated /><el-empty v-else-if="!records.length" :description="`${title}暂时没有结果`"><el-button type="primary" @click="createScan">开始扫描</el-button></el-empty><div v-else class="record-list"><article v-for="row in records" :key="row.sourceId || row.entityId || row.opportunityId || row.contentTopicId || row.taskId || row.signalId" class="record"><div><span class="record-kicker">{{ view === 'sources' ? row.sourceGroup : view === 'history' ? `任务 #${row.taskId}` : view === 'trends' ? row.entityType : view === 'opportunities' ? 'OPPORTUNITY' : view === 'topics' ? 'CONTENT TOPIC' : 'SIGNAL' }}</span><h3>{{ row.name || row.title || row.coreViewpoint || `扫描任务 ${row.taskId}` }}</h3><p>{{ row.summary || row.coreViewpoint || `${row.discoveredCount ?? 0} 条发现 · ${row.signalCount ?? 0} 条信号` }}</p></div><div class="record-actions"><el-tag v-if="view === 'sources'" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '已启用' : '已停用' }}</el-tag><el-tag v-else>{{ row.status || row.evidenceLevel || '可查看' }}</el-tag><el-button v-if="view === 'sources'" text type="primary" @click="toggleSource(row)">{{ row.enabled ? '停用' : '启用' }}</el-button><el-button v-if="view === 'opportunities'" text type="primary" @click="openDetails('opportunities', row.opportunityId)">查看详情</el-button><el-button v-if="view === 'topics'" text type="primary" @click="openDetails('content-topics', row.contentTopicId)">查看详情</el-button><el-button v-if="view === 'saved'" text type="primary" @click="openDetails('signals', row.signalId)">查看详情</el-button></div></article></div><div v-if="nextCursor" class="load-more"><el-button :loading="loading" @click="loadView(true)">加载更多</el-button></div></section>
      <el-drawer v-model="detailsOpen" :title="details?.title || '详情'" size="min(560px, 100%)" :with-header="true">
        <el-skeleton v-if="detailsLoading" :rows="7" animated />
        <div v-else-if="details" class="detail-body">
          <p>{{ details.summary || details.coreViewpoint }}</p>
          <el-descriptions :column="1" border size="small"><el-descriptions-item label="价值分">{{ details.valueScore ?? details.evidenceScore }}</el-descriptions-item><el-descriptions-item v-if="details.evidenceLevel" label="证据等级">{{ details.evidenceLevel }}</el-descriptions-item><el-descriptions-item v-if="details.validationAction" label="验证动作">{{ details.validationAction }}</el-descriptions-item><el-descriptions-item v-if="details.technologyChange" label="技术变化">{{ details.technologyChange }}</el-descriptions-item></el-descriptions>
          <h3>证据来源</h3><el-empty v-if="!details.evidence?.length" description="暂无可回溯证据" /><ul v-else class="evidence-list"><li v-for="source in details.evidence" :key="source.discoveryId"><a :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title || source.url }}</a><small>{{ source.sourceName || source.url }}</small></li></ul>
          <template v-if="details.risks?.length"><h3>风险</h3><p v-for="risk in details.risks" :key="risk">{{ risk }}</p></template>
          <template v-if="details.uncertainties?.length"><h3>不确定性</h3><p v-for="item in details.uncertainties" :key="item">{{ item }}</p></template>
          <template v-if="details.platformAngles"><h3>平台角度</h3><p v-for="(angle, platform) in details.platformAngles" :key="platform"><strong>{{ platform }}</strong>：{{ angle }}</p></template>
        </div>
      </el-drawer>
    </main>
  </div>
</template>
