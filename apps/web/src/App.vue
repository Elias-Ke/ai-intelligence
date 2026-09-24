<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Compass, DataAnalysis, Document, FolderOpened, House, List, Monitor, Plus, Refresh, Search, Setting, Star, TrendCharts } from '@element-plus/icons-vue';

type View = 'dashboard' | 'stream' | 'trends' | 'opportunities' | 'topics' | 'saved' | 'history' | 'sources';
type Signal = { signalId: number; title: string; summary: string; valueScore: number; evidenceLevel: string; tags?: string[]; sourceName?: string };
const view = ref<View>('dashboard');
const signals = ref<Signal[]>([]); const records = ref<Record<string, any>[]>([]); const loading = ref(false); const query = ref(''); const scanRange = ref('24h'); const scanStatus = ref(''); const activeTaskId = ref<number | null>(null);
const nav = [{ key: 'dashboard', label: '今日扫描', icon: House }, { key: 'stream', label: '完整情报流', icon: DataAnalysis }, { key: 'trends', label: '趋势追踪', icon: TrendCharts }, { key: 'opportunities', label: '副业机会', icon: Compass }, { key: 'topics', label: '内容选题', icon: Document }, { key: 'saved', label: '收藏', icon: Star }, { key: 'history', label: '扫描历史', icon: List }, { key: 'sources', label: '来源库', icon: FolderOpened }] as const;
const title = computed(() => nav.find((item) => item.key === view.value)?.label ?? '今日扫描');

async function loadSignals() { loading.value = true; try { const response = await fetch(`/api/signals?limit=30${query.value ? `&q=${encodeURIComponent(query.value)}` : ''}`); const body = await response.json(); if (body.code !== 0) throw new Error(`${body.message}（${body.code}）`); signals.value = body.data.items; } catch (error) { ElMessage.error(error instanceof Error ? error.message : '情报加载失败'); } finally { loading.value = false; } }
async function loadView() {
  if (view.value === 'dashboard' || view.value === 'stream') return loadSignals();
  const endpoint: Record<string, string> = { trends: '/api/entities', opportunities: '/api/opportunities', topics: '/api/content-topics', saved: '/api/signals?saved=true', history: '/api/scans', sources: '/api/sources' };
  loading.value = true;
  try { const response = await fetch(`${endpoint[view.value]}${endpoint[view.value].includes('?') ? '&' : '?'}limit=30`); const body = await response.json(); if (body.code !== 0) throw new Error(`${body.message}（${body.code}，${body.requestId}）`); records.value = body.data.items; } catch (error) { ElMessage.error(error instanceof Error ? error.message : '数据加载失败'); } finally { loading.value = false; }
}
async function createScan() {
  try { await ElMessageBox.confirm(`扫描范围：${scanRange.value === '24h' ? '过去 24 小时' : scanRange.value === '3d' ? '过去 3 天' : '过去 7 天'}，将同时执行来源库和全网发现。`, '开始新一轮扫描', { confirmButtonText: '开始扫描', cancelButtonText: '取消' }); } catch { return; }
  const key = `web-${Date.now()}`; const response = await fetch('/api/scans', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ range: scanRange.value }) }); const body = await response.json();
  if (body.code !== 0) { ElMessage.error(`${body.message}（${body.code}，${body.requestId}）`); return; } activeTaskId.value = body.data.taskId; scanStatus.value = body.data.status; ElMessage.success('扫描任务已创建');
}
async function toggleSource(row: Record<string, any>) { const response = await fetch(`/api/sources/${row.sourceId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !Boolean(row.enabled) }) }); const body = await response.json(); if (body.code !== 0) { ElMessage.error(`${body.message}（${body.code}）`); return; } row.enabled = body.data.enabled; ElMessage.success(row.enabled ? '来源已启用' : '来源已停用'); }
function go(next: View) { view.value = next; query.value = ''; loadView(); }
onMounted(loadView);
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
      <header class="topbar"><div><div class="eyebrow">SIGNAL / AI INTELLIGENCE</div><h1>{{ title }}</h1><p>把 AI 前沿变化整理成可核查的信号、可验证的副业机会和可持续的内容选题。</p></div><div class="top-actions"><el-button :icon="Refresh" circle aria-label="刷新" @click="loadSignals" /><el-button type="primary" :icon="Plus" @click="createScan">开始扫描</el-button></div></header>
      <section v-if="view === 'dashboard'" class="scan-panel"><div><h2>手动触发一轮情报扫描</h2><p>来源库保证稳定，全网发现负责找新信号。任务运行在当前 Node.js 进程中。</p></div><div class="scan-controls"><el-select v-model="scanRange" style="width:150px"><el-option label="过去 24 小时" value="24h" /><el-option label="过去 3 天" value="3d" /><el-option label="过去 7 天" value="7d" /></el-select><el-button type="primary" :icon="Search" @click="createScan">开始扫描</el-button></div><div class="scan-status"><span>当前任务</span><strong>{{ scanStatus || '尚未运行' }}</strong><el-progress :percentage="activeTaskId ? 12 : 0" :show-text="false" /><small>{{ activeTaskId ? `任务 #${activeTaskId} 已创建` : '点击开始，系统会保存完整扫描历史' }}</small></div></section>
      <section class="stats"><article><span>本轮发现</span><strong>--</strong><small>等待下一轮扫描</small></article><article><span>重点信号</span><strong>{{ signals.length || '--' }}</strong><small>证据优先排序</small></article><article><span>副业机会</span><strong>--</strong><small>达到门槛后生成</small></article><article><span>内容选题</span><strong>--</strong><small>事实可回溯</small></article></section>
      <section v-if="view === 'dashboard' || view === 'stream'" class="content-panel"><div class="section-head"><div><h2>{{ view === 'dashboard' ? '本轮重点信号' : '完整情报流' }}</h2><span>优先展示价值、证据和落地变化</span></div><el-input v-if="view === 'stream'" v-model="query" clearable placeholder="搜索主题、公司或技术" :prefix-icon="Search" @keyup.enter="loadSignals" /></div><el-skeleton v-if="loading" :rows="5" animated /><el-empty v-else-if="!signals.length" description="还没有可展示的情报，先开始一轮扫描" /><div v-else class="signal-list"><article v-for="signal in signals" :key="signal.signalId" class="signal"><div class="signal-top"><span class="source">{{ signal.sourceName || '多来源聚类信号' }}</span><el-tag type="success">价值 {{ signal.valueScore }}</el-tag></div><h3>{{ signal.title }}</h3><p>{{ signal.summary }}</p><div class="tags"><el-tag v-for="tag in signal.tags || []" :key="tag" size="small">{{ tag }}</el-tag><el-tag size="small" type="warning">{{ signal.evidenceLevel }}</el-tag></div><footer><span>#{{ signal.signalId }} · 可打开证据详情</span><el-button text type="primary" @click="go('stream')">查看详情</el-button></footer></article></div></section>
      <section v-else class="content-panel"><div class="section-head"><div><h2>{{ title }}</h2><span>数据来自已完成扫描和当前持久化状态</span></div><el-button :icon="Refresh" @click="loadView">刷新</el-button></div><el-skeleton v-if="loading" :rows="5" animated /><el-empty v-else-if="!records.length" :description="`${title}暂时没有结果`"><el-button type="primary" @click="createScan">开始扫描</el-button></el-empty><div v-else class="record-list"><article v-for="row in records" :key="row.sourceId || row.entityId || row.opportunityId || row.contentTopicId || row.taskId || row.signalId" class="record"><div><span class="record-kicker">{{ view === 'sources' ? row.sourceGroup : view === 'history' ? `任务 #${row.taskId}` : view === 'trends' ? row.entityType : view === 'opportunities' ? 'OPPORTUNITY' : view === 'topics' ? 'CONTENT TOPIC' : 'SIGNAL' }}</span><h3>{{ row.name || row.title || row.coreViewpoint || `扫描任务 ${row.taskId}` }}</h3><p>{{ row.summary || row.coreViewpoint || `${row.discoveredCount ?? 0} 条发现 · ${row.signalCount ?? 0} 条信号` }}</p></div><div class="record-actions"><el-tag v-if="view === 'sources'" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '已启用' : '已停用' }}</el-tag><el-tag v-else>{{ row.status || row.evidenceLevel || '可查看' }}</el-tag><el-button v-if="view === 'sources'" text type="primary" @click="toggleSource(row)">{{ row.enabled ? '停用' : '启用' }}</el-button></div></article></div></section>
    </main>
  </div>
</template>
