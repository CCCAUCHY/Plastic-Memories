/**
 * 极简 JSON Schema 参数校验器 —— 补回「零依赖」丢掉的最大能力。
 *
 * 为什么需要它：`defineTool`（`@deepseek-ai/dsh-tools`）在 execute 之前会做
 * `validateJsonSchemaValue(parameterSchemaSpecToJsonSchema(parameters), args, '')`，
 * 违规时抛 `ToolArgsError`。我们手工构造 ToolDefinition 时**跳过了这一层**，
 * 于是模型送来的类型错误 / 未知字段不会被拦下。
 *
 * 本模块按 `defineTool` 的**行为**（而不是仅产物形状）补回这一层，
 * 仍然零依赖。支持 DSH 工具 schema 实际用到的子集。
 *
 * @module dsh-plugin-plastic-memories-h0/schema
 */

const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

/** 描述一个值，用于错误信息。 */
function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isSafeInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true; // 未知类型关键字不阻塞
  }
}

/**
 * 校验一个值是否符合 schema 子集。
 * @param {object} schema - JSON Schema 片段。
 * @param {unknown} value - 待校验值。
 * @param {string} path - 当前 JSON 路径（错误信息用）。
 * @param {string[]} out - 违规信息收集器。
 */
function check(schema, value, path, out) {
  if (schema === null || typeof schema !== 'object') return;

  if (typeof schema.type === 'string' && TYPES.has(schema.type) && !matchesType(value, schema.type)) {
    out.push(path + ': 期望 ' + schema.type + '，收到 ' + kindOf(value));
    return;
  }
  // oneOf：DSH 的 ParameterPropertySpec 就是 ValueSchemaSpec，原生支持 oneOf，
  // 所以「整数或 'this'」这种参数对宿主与供应商都是合法的。
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const branch = schema.oneOf.find((candidate) => {
      const probe = [];
      check(candidate, value, path, probe);
      return probe.length === 0;
    });
    if (branch === undefined) out.push(path + ': 不匹配任何一个允许的形态（' + JSON.stringify(value) + '）');
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    out.push(path + ': 必须是 ' + schema.enum.map((v) => JSON.stringify(v)).join(' | ') + ' 之一，收到 ' + JSON.stringify(value));
    return;
  }
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    out.push(path + ': 必须 >= ' + schema.minimum + '，收到 ' + value);
  }
  if (typeof schema.maximum === 'number' && typeof value === 'number' && value > schema.maximum) {
    out.push(path + ': 必须 <= ' + schema.maximum + '，收到 ' + value);
  }

  if (Array.isArray(value)) {
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i++) check(schema.items, value[i], path + '[' + i + ']', out);
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    const properties = schema.properties !== null && typeof schema.properties === 'object' ? schema.properties : {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) out.push(path + ': 缺少必需字段 ' + JSON.stringify(name));
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) check(child, value[name], path === '' ? name : path + '.' + name, out);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) out.push(path + ': 未知字段 ' + JSON.stringify(name));
      }
    }
  }
}

/**
 * 编译一个参数校验函数（与 `defineTool` 内建的那层等价）。
 * @param {object} parametersSchema - 工具的参数 JSON Schema。
 * @returns {(args: unknown) => string[]} 返回违规列表；空数组表示通过。
 */
export function compileArgsValidator(parametersSchema) {
  return (args) => {
    const out = [];
    check(parametersSchema, args, '', out);
    return out;
  };
}

/** 参数校验失败。名字与宿主一致，便于调用方按类型区分。 */
export class ToolArgsError extends Error {
  /** @param {string[]} violations - 违规列表。 */
  constructor(violations) {
    super('Invalid tool arguments: ' + violations.join('; '));
    this.name = 'ToolArgsError';
    this.violations = violations;
  }
}
