export const ErrorCodes = {
  INVALID_REQUEST: 100001,
  INVALID_CURSOR: 100002,
  INTERNAL: 100003,
  DATABASE_UNAVAILABLE: 100004,
  INVALID_SCAN_RANGE: 200001,
  MISSING_IDEMPOTENCY_KEY: 200002,
  IDEMPOTENCY_CONFLICT: 200003,
  NO_AVAILABLE_SOURCE: 200004,
  SCAN_NOT_FOUND: 200005,
  RETRY_NOT_ALLOWED: 200006,
  ACTIVE_SCAN_EXISTS: 200007,
  SSE_ACCEPT_REQUIRED: 200008,
  INVALID_SCAN_FILTER: 200009,
  INVALID_DISCOVERY_FILTER: 300001,
  SOURCE_TIMEOUT: 300002,
  SOURCE_ACCESS_DENIED: 300003,
  EXTRACTION_FAILED: 300004,
  SEARCH_QUOTA_EXHAUSTED: 300005,
  SEARCH_RATE_LIMITED: 300006,
  SEARCH_UNAVAILABLE: 300007,
  INVALID_SIGNAL_FILTER: 400001,
  INVALID_FTS_QUERY: 400002,
  SIGNAL_NOT_FOUND: 400003,
  INVALID_SIGNAL_STATE: 400004,
  ITEM_NOT_FOUND: 450001,
  EMPTY_ITEM_STATE: 450002,
  CONTRADICTORY_ITEM_STATE: 450003,
  INVALID_OPPORTUNITY_FILTER: 500001,
  OPPORTUNITY_NOT_FOUND: 500002,
  INVALID_OPPORTUNITY_STATUS: 500003,
  INVALID_TOPIC_FILTER: 600001,
  TOPIC_NOT_FOUND: 600002,
  INVALID_TOPIC_STATUS: 600003,
  INVALID_ENTITY_FILTER: 700001,
  ENTITY_NOT_FOUND: 700002,
  INVALID_SOURCE_FILTER: 800001,
  SOURCE_NOT_FOUND: 800002,
  LAST_SOURCE: 800003,
  INVALID_SOURCE_URL: 800004,
  UNSAFE_SOURCE_URL: 800005,
  DUPLICATE_SOURCE_URL: 800006,
  SOURCE_UNREACHABLE: 800007,
  FTS_UNAVAILABLE: 900001
  ,LLM_TIMEOUT: 910001
  ,LLM_INVALID_RESPONSE: 910002
  ,CARD_MISSING_EVIDENCE: 910003
  ,LLM_NOT_CONFIGURED: 910004
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

const messages: Record<ErrorCode, string> = {
  100001: '请求参数不正确', 100002: '分页游标无效，请刷新后重试', 100003: '系统暂时无法处理请求', 100004: '数据服务暂时不可用，请稍后重试',
  200001: '扫描时间范围不正确，最长支持 30 天', 200002: '缺少 Idempotency-Key 请求头', 200003: '该请求标识已用于其他扫描参数', 200004: '没有可用的来源或搜索配置，无法开始扫描', 200005: '扫描任务不存在或已失效', 200006: '当前扫描状态不允许重试', 200007: '已有扫描正在运行，请等待完成后重试', 200008: '该接口只支持 text/event-stream', 200009: '扫描历史筛选条件不正确',
  300001: '原始发现筛选条件不正确', 300002: '来源访问超时', 300003: '来源需要登录、付费或禁止公开访问', 300004: '正文提取失败，已保留基础信息', 300005: 'AnySearch 配额已用完，本轮已停止新增搜索', 300006: 'AnySearch 请求过于频繁，稍后重试', 300007: 'AnySearch 服务暂时不可用', 400001: '情报筛选或排序条件不正确', 400002: '搜索词无法解析，请减少特殊符号后重试', 400003: '该情报不存在或已失效', 400004: '情报状态不正确',
  450001: '操作对象不存在或已失效', 450002: '请至少提交一个需要更新的状态', 450003: '收藏和忽略不能同时开启',
  500001: '机会筛选或排序条件不正确', 500002: '该副业机会不存在或已失效', 500003: '副业机会状态不正确',
  600001: '选题筛选或排序条件不正确', 600002: '该内容选题不存在或已失效', 600003: '内容选题状态不正确',
  700001: '趋势筛选或排序条件不正确', 700002: '该趋势对象不存在或已失效',
  800001: '来源筛选条件不正确', 800002: '该来源不存在或已失效', 800003: '至少需要保留一个可用来源或搜索配置', 800004: '来源地址必须是公开的 HTTP 或 HTTPS 地址', 800005: '来源地址指向不允许访问的网络位置', 800006: '该来源地址已经存在', 800007: '暂时无法访问该来源，请检查地址或稍后重试',
  900001: '全文检索能力不可用，服务尚未就绪', 910001: '生成式模型响应超时', 910002: '生成式模型返回的数据格式不正确', 910003: '卡片缺少可回溯证据', 910004: '生成式模型尚未配置，已保留基础情报'
};

export class BusinessError extends Error {
  constructor(public readonly code: ErrorCode, public readonly details?: Record<string, unknown>) { super(messages[code]); }
  get statusCode() {
    if (this.code === ErrorCodes.SSE_ACCEPT_REQUIRED) return 406;
    if ([ErrorCodes.SCAN_NOT_FOUND, ErrorCodes.SIGNAL_NOT_FOUND, ErrorCodes.ITEM_NOT_FOUND, ErrorCodes.OPPORTUNITY_NOT_FOUND, ErrorCodes.TOPIC_NOT_FOUND, ErrorCodes.ENTITY_NOT_FOUND, ErrorCodes.SOURCE_NOT_FOUND].includes(this.code as never)) return 404;
    if ([ErrorCodes.IDEMPOTENCY_CONFLICT, ErrorCodes.NO_AVAILABLE_SOURCE, ErrorCodes.RETRY_NOT_ALLOWED, ErrorCodes.ACTIVE_SCAN_EXISTS, ErrorCodes.LAST_SOURCE].includes(this.code as never)) return 409;
    if (this.code === ErrorCodes.SOURCE_UNREACHABLE) return 502;
    if ([ErrorCodes.DATABASE_UNAVAILABLE, ErrorCodes.FTS_UNAVAILABLE].includes(this.code as never)) return 503;
    if (this.code === ErrorCodes.INTERNAL) return 500;
    return 400;
  }
}
