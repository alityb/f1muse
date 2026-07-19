import Anthropic from '@anthropic-ai/sdk';
import { F1QLProgram } from './ast';
import { parseF1QLProgram } from './schema';

const SYSTEM_PROMPT = `Convert the user's F1 statistics question into one F1QL JSON program.
Use the emit_f1ql_program tool exactly once. Never output SQL, prose, markdown, or a legacy query intent.
Supported root operations only:
- aggregate and rank over official driver standings
- pace_summary for one driver's valid race-lap pace
- pace_delta for the pace difference between two drivers
Use canonical lowercase hyphenated driver IDs. Reject unsupported requests by outputting {"version":1,"root":{"op":"unsupported"}}.`;

export interface F1QLTextModel {
  complete(systemPrompt: string, question: string): Promise<string>;
}

export class AnthropicF1QLModel implements F1QLTextModel {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model = process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307') {
    this.client = new Anthropic({ apiKey });
  }

  async complete(systemPrompt: string, question: string): Promise<string> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: question }],
      tools: [{
        name: 'emit_f1ql_program',
        description: 'Emit exactly one candidate F1QL program as a JSON object.',
        input_schema: {
          type: 'object',
          additionalProperties: true
        }
      }],
      tool_choice: { type: 'tool', name: 'emit_f1ql_program' }
    });
    const toolUse = message.content.find((content) => content.type === 'tool_use');
    return toolUse?.type === 'tool_use' ? JSON.stringify(toolUse.input) : '';
  }
}

export async function translateF1QLQuestion(question: string, model: F1QLTextModel): Promise<F1QLProgram> {
  let output: unknown;
  try {
    output = JSON.parse(await model.complete(SYSTEM_PROMPT, question));
  } catch {
    throw new Error('F1QL translation did not return valid JSON');
  }
  return parseF1QLProgram(output);
}
