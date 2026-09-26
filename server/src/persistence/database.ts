import Database from 'better-sqlite3';
import { schemaSql } from './schema.js';

export type SqliteDatabase = Database.Database;
export function openDatabase(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  try { db.transaction(() => {
    db.exec(schemaSql);
    const columns = new Set((db.pragma('table_info(scan_discoveries)') as { name: string }[]).map(({ name }) => name));
    if (!columns.has('status')) db.exec("ALTER TABLE scan_discoveries ADD COLUMN status TEXT CHECK(status IN ('candidate','accepted','rejected','extract_failed'))");
    if (!columns.has('rejection_reason')) db.exec('ALTER TABLE scan_discoveries ADD COLUMN rejection_reason TEXT');
    const signalColumns = new Set((db.pragma('table_info(scan_signals)') as { name: string }[]).map(({ name }) => name));
    const snapshots = [
      ['evidence_level', "TEXT CHECK(evidence_level IN ('single_source','multi_source','first_party','conflicting'))"],
      ['state', "TEXT CHECK(state IN ('active','needs_review','archived'))"],
      ['truth_score', 'INTEGER CHECK(truth_score BETWEEN 0 AND 100)'],
      ['value_score', 'INTEGER CHECK(value_score BETWEEN 0 AND 100)'],
      ['evidence_count', 'INTEGER CHECK(evidence_count>=0)'],
      ['published_at_verified', 'INTEGER CHECK(published_at_verified IN (0,1))']
    ] as const;
    for (const [name, definition] of snapshots) if (!signalColumns.has(name)) db.exec(`ALTER TABLE scan_signals ADD COLUMN ${name} ${definition}`);
    seedSources(db);
  })(); }
  catch (error) { db.close(); throw error; }
  return db;
}

function seedSources(db: SqliteDatabase) {
  const sources = [
    ['OpenAI', '国际官方', 'web', 'https://openai.com/news/', 'en', 'intl', 5],
    ['Anthropic', '国际官方', 'web', 'https://www.anthropic.com/news', 'en', 'intl', 5],
    ['Google AI', '国际官方', 'web', 'https://blog.google/technology/ai/', 'en', 'intl', 5],
    ['DeepMind', '国际官方', 'web', 'https://deepmind.google/discover/blog/', 'en', 'intl', 5],
    ['Microsoft AI', '国际官方', 'web', 'https://blogs.microsoft.com/ai/', 'en', 'intl', 5],
    ['AWS ML', '国际官方', 'web', 'https://aws.amazon.com/blogs/machine-learning/', 'en', 'intl', 5],
    ['Meta AI', '国际官方', 'web', 'https://ai.meta.com/blog/', 'en', 'intl', 5],
    ['NVIDIA AI', '国际官方', 'web', 'https://blogs.nvidia.com/blog/category/generative-ai/', 'en', 'intl', 5],
    ['Hugging Face', '研究开源', 'web', 'https://huggingface.co/blog', 'en', 'global', 4],
    ['Mistral AI', '国际官方', 'web', 'https://mistral.ai/news/', 'en', 'intl', 5],
    ['文心智能体', '国内官方', 'web', 'https://yiyan.baidu.com/', 'zh-CN', 'cn', 5],
    ['通义千问', '国内官方', 'web', 'https://qwenlm.github.io/', 'zh-CN', 'cn', 5],
    ['腾讯混元', '国内官方', 'web', 'https://hunyuan.tencent.com/', 'zh-CN', 'cn', 5],
    ['豆包与火山引擎', '国内官方', 'web', 'https://www.volcengine.com/product/ark', 'zh-CN', 'cn', 5],
    ['智谱 AI', '国内官方', 'web', 'https://www.zhipuai.cn/news', 'zh-CN', 'cn', 5],
    ['月之暗面', '国内官方', 'web', 'https://www.moonshot.cn/', 'zh-CN', 'cn', 5],
    ['DeepSeek', '国内官方', 'web', 'https://www.deepseek.com/', 'zh-CN', 'cn', 5],
    ['MiniMax', '国内官方', 'web', 'https://www.minimaxi.com/news', 'zh-CN', 'cn', 5],
    ['arXiv cs.AI', '研究开源', 'rss', 'https://rss.arxiv.org/rss/cs.AI', 'en', 'global', 4],
    ['arXiv cs.CL', '研究开源', 'rss', 'https://rss.arxiv.org/rss/cs.CL', 'en', 'global', 4],
    ['arXiv cs.LG', '研究开源', 'rss', 'https://rss.arxiv.org/rss/cs.LG', 'en', 'global', 4],
    ['arXiv cs.CV', '研究开源', 'rss', 'https://rss.arxiv.org/rss/cs.CV', 'en', 'global', 4],
    ['GitHub Search', '研究开源', 'api', 'https://api.github.com/search/repositories?q=ai+agent&sort=updated&order=desc&per_page=40', 'en', 'global', 4],
    ['机器之心', '科技媒体', 'web', 'https://www.jiqizhixin.com/', 'zh-CN', 'cn', 3],
    ['量子位', '科技媒体', 'web', 'https://www.qbitai.com/', 'zh-CN', 'cn', 3],
    ['36氪 AI', '科技媒体', 'web', 'https://36kr.com/information/AI', 'zh-CN', 'cn', 3],
    ['TechCrunch AI', '科技媒体', 'web', 'https://techcrunch.com/category/artificial-intelligence/', 'en', 'intl', 3],
    ['VentureBeat AI', '科技媒体', 'web', 'https://venturebeat.com/category/ai/', 'en', 'intl', 3],
    ['The Verge AI', '科技媒体', 'web', 'https://www.theverge.com/ai-artificial-intelligence', 'en', 'intl', 3],
    ['HF Papers', '研究开源', 'web', 'https://huggingface.co/papers', 'en', 'global', 4]
  ] as const;
  const insert = db.prepare('INSERT OR IGNORE INTO sources(name,source_group,kind,url,language,region,trust_level,enabled,fetch_interval_minutes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1440,?,?)');
  const timestamp = new Date().toISOString();
  const upgrade = db.prepare("UPDATE sources SET kind=?,url=?,updated_at=? WHERE name=? AND url=? AND kind='web' AND NOT EXISTS(SELECT 1 FROM sources WHERE url=?)");
  const transaction = db.transaction(() => {
    for (const source of sources) {
      const legacyUrl = source[0].startsWith('arXiv cs.') ? `https://arxiv.org/list/${source[0].slice(6)}/recent` : source[0] === 'GitHub Search' ? 'https://github.com/search?q=AI&type=repositories' : null;
      if (legacyUrl) upgrade.run(source[2], source[3], timestamp, source[0], legacyUrl, source[3]);
      insert.run(...source, timestamp, timestamp);
    }
  });
  transaction();
}
