import * as fs from 'fs';
import * as path from 'path';
import { ApprovedSqlTemplateId, APPROVED_SQL_TEMPLATES } from '../types/database';

/**
 * SQL template cache
 */
interface TemplateCache {
  [key: string]: string;
}

/**
 * Loads and caches SQL templates from /templates directory
 */
export class TemplateLoader {
  private cache: TemplateCache = {};
  private templatesDir: string;

  constructor(templatesDir?: string) {
    this.templatesDir = templatesDir || path.join(process.cwd(), 'templates');
  }

  /**
   * Load a template by ID
   */
  load(templateId: ApprovedSqlTemplateId): string {
    // Check cache first
    if (this.cache[templateId]) {
      return this.cache[templateId];
    }

    // Verify template ID is approved
    if (!APPROVED_SQL_TEMPLATES.includes(templateId)) {
      throw new Error(`Unapproved SQL template: ${templateId}`);
    }

    // Load from file
    const templatePath = path.join(this.templatesDir, `${templateId}.sql`);

    if (!fs.existsSync(templatePath)) {
      throw new Error(`SQL template file not found: ${templatePath}`);
    }

    const sql = fs.readFileSync(templatePath, 'utf-8');

    // Cache for future use
    this.cache[templateId] = sql;

    return sql;
  }

  /**
   * Preload all templates into cache
   */
  preloadAll(): void {
    for (const templateId of APPROVED_SQL_TEMPLATES) {
      this.load(templateId);
    }
  }

  /**
   * Clear template cache (useful for testing)
   */
  clearCache(): void {
    this.cache = {};
  }
}
