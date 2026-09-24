import Database from 'better-sqlite3';
import { schemaSql } from './schema.js';

export type SqliteDatabase = Database.Database;
export function openDatabase(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(schemaSql);
  seedSources(db);
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
    ['arXiv cs.AI', '研究开源', 'web', 'https://arxiv.org/list/cs.AI/recent', 'en', 'global', 4],
    ['arXiv cs.CL', '研究开源', 'web', 'https://arxiv.org/list/cs.CL/recent', 'en', 'global', 4],
    ['arXiv cs.LG', '研究开源', 'web', 'https://arxiv.org/list/cs.LG/recent', 'en', 'global', 4],
    ['arXiv cs.CV', '研究开源', 'web', 'https://arxiv.org/list/cs.CV/recent', 'en', 'global', 4],
    ['GitHub Search', '研究开源', 'web', 'https://github.com/search?q=AI&type=repositories', 'en', 'global', 4],
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
  const transaction = db.transaction(() => { for (const source of sources) insert.run(...source, timestamp, timestamp); });
  transaction();
}
