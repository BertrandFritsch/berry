import {npath}                      from '@yarnpkg/fslib';

import chalk                        from 'chalk';

import {Configuration}              from './Configuration';
import * as miscUtils               from './miscUtils';
import * as structUtils             from './structUtils';
import {Descriptor, Locator, Ident} from './types';

export enum Type {
  NO_HINT = `NO_HINT`,

  NULL = `NULL`,

  SCOPE = `SCOPE`,
  NAME = `NAME`,
  RANGE = `RANGE`,
  REFERENCE = `REFERENCE`,

  NUMBER = `NUMBER`,
  PATH = `PATH`,
  URL = `URL`,
  ADDED = `ADDED`,
  REMOVED = `REMOVED`,
  CODE = `CODE`,

  DURATION = `DURATION`,
  SIZE = `SIZE`,

  IDENT = `IDENT`,
  DESCRIPTOR = `DESCRIPTOR`,
  LOCATOR = `LOCATOR`,
  RESOLUTION = `RESOLUTION`,
  DEPENDENT = `DEPENDENT`,
}

export enum Style {
  BOLD = 1 << 1
}

const chalkOptions = process.env.GITHUB_ACTIONS
  ? {level: 2}
  : chalk.supportsColor
    ? {level: chalk.supportsColor.level}
    : {level: 0};

export const supportsColor = chalkOptions.level !== 0;
export const supportsHyperlinks = supportsColor && !process.env.GITHUB_ACTIONS;

const chalkInstance = new chalk.Instance(chalkOptions);

const colors = new Map([
  [Type.NO_HINT, null],

  [Type.NULL, [`#a853b5`, 129]],

  [Type.SCOPE, [`#d75f00`, 166]],
  [Type.NAME, [`#d7875f`, 173]],
  [Type.RANGE, [`#00afaf`, 37]],
  [Type.REFERENCE, [`#87afff`, 111]],

  [Type.NUMBER, [`#ffd700`, 220]],
  [Type.PATH, [`#d75fd7`, 170]],
  [Type.URL, [`#d75fd7`, 170]],
  [Type.ADDED, [`#5faf00`, 70]],
  [Type.REMOVED, [`#d70000`, 160]],
  [Type.CODE, [`#87afff`, 111]],

  [Type.SIZE, [`#ffd700`, 220]],
]);

// Just to make sure that the individual fields of the transform map have
// compatible parameter types, without upcasting the map to a too generic type
//
// We also take the opportunity to downcast the configuration into `any`,
// otherwise TypeScript will detect a circular reference and won't allow us to
// properly type the `format` method from Configuration. Since transforms are
// internal to this file, it should be fine.
const validateTransform = <T>(spec: {
  pretty: (configuration: any, val: T) => string,
  json: (val: T) => any
}): {
  pretty: (configuration: any, val: T) => string,
  json: (val: T) => any,
} => spec;

const transforms = {
  [Type.NUMBER]: validateTransform({
    pretty: (configuration: Configuration, value: number) => {
      return `${value}`;
    },
    json: (value: number) => {
      return value;
    },
  }),

  [Type.IDENT]: validateTransform({
    pretty: (configuration: Configuration, ident: Ident) => {
      return structUtils.prettyIdent(configuration, ident);
    },
    json: (ident: Ident) => {
      return structUtils.stringifyIdent(ident);
    },
  }),

  [Type.LOCATOR]: validateTransform({
    pretty: (configuration: Configuration, locator: Locator) => {
      return structUtils.prettyLocator(configuration, locator);
    },
    json: (locator: Locator) => {
      return structUtils.stringifyLocator(locator);
    },
  }),

  [Type.DESCRIPTOR]: validateTransform({
    pretty: (configuration: Configuration, descriptor: Descriptor) => {
      return structUtils.prettyDescriptor(configuration, descriptor);
    },
    json: (descriptor: Descriptor) => {
      return structUtils.stringifyDescriptor(descriptor);
    },
  }),

  [Type.RESOLUTION]: validateTransform({
    pretty: (configuration: Configuration, {descriptor, locator}: {descriptor: Descriptor, locator: Locator | null}) => {
      return structUtils.prettyResolution(configuration, descriptor, locator);
    },
    json: ({descriptor, locator}: {descriptor: Descriptor, locator: Locator | null}) => {
      return {
        descriptor: structUtils.stringifyDescriptor(descriptor),
        locator: locator !== null
          ? structUtils.stringifyLocator(locator)
          : null,
      };
    },
  }),

  [Type.DEPENDENT]: validateTransform({
    pretty: (configuration: Configuration, {locator, descriptor}: {locator: Locator, descriptor: Descriptor}) => {
      return structUtils.prettyDependent(configuration, locator, descriptor);
    },
    json: ({locator, descriptor}: {locator: Locator, descriptor: Descriptor}) => {
      return {
        locator: structUtils.stringifyLocator(locator),
        descriptor: structUtils.stringifyDescriptor(descriptor),
      };
    },
  }),

  [Type.DURATION]: validateTransform({
    pretty: (configuration: Configuration, duration: number) => {
      if (duration > 1000 * 60) {
        const minutes = Math.floor(duration / 1000 / 60);
        const seconds = Math.ceil((duration - minutes * 60 * 1000) / 1000);
        return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
      } else {
        const seconds = Math.floor(duration / 1000);
        const milliseconds = duration - seconds * 1000;
        return milliseconds === 0 ? `${seconds}s` : `${seconds}s ${milliseconds}ms`;
      }
    },
    json: (duration: number) => {
      return duration;
    },
  }),

  [Type.SIZE]: validateTransform({
    pretty: (configuration: Configuration, size: number) => {
      const thresholds = [`KB`, `MB`, `GB`, `TB`];

      let power = thresholds.length;
      while (power > 1 && size < 1024 ** power)
        power -= 1;

      const factor = 1024 ** power;
      const value = Math.floor(size * 100 / factor) / 100;

      return applyColor(configuration, `${value} ${thresholds[power - 1]}`, Type.NUMBER);
    },
    json: (size: number) => {
      return size;
    },
  }),

  [Type.PATH]: validateTransform({
    pretty: (configuration: Configuration, filePath: string) => {
      return applyColor(configuration, npath.fromPortablePath(filePath), Type.PATH);
    },
    json: (filePath: string) => {
      return npath.fromPortablePath(filePath) as string;
    },
  }),
};

type AllTransforms = typeof transforms;

export type Source<T> = T extends keyof AllTransforms
  ? Parameters<AllTransforms[T]['json']>[0] | null
  : string | null;

export type Tuple<T extends Type = Type> =
  readonly [Source<T>, T];

export function tuple<T extends Type>(formatType: T, value: Source<T>): Tuple<T> {
  return [value, formatType];
}

export function applyStyle(configuration: Configuration, text: string, flags: Style): string {
  if (!configuration.get<boolean>(`enableColors`))
    return text;

  if (flags & Style.BOLD)
    text = chalk.bold(text);

  return text;
}

export function applyColor(configuration: Configuration, value: string, formatType: Type | string): string {
  if (!configuration.get<boolean>(`enableColors`))
    return value;

  const colorSpec = colors.get(formatType as Type);
  if (colorSpec === null)
    return value;

  const color = typeof colorSpec === `undefined`
    ? formatType
    : chalkOptions.level >= 3
      ? colorSpec[0]
      : colorSpec[1];

  const fn = typeof color === `number`
    ? chalkInstance.ansi256(color)
    : color.startsWith(`#`)
      ? chalkInstance.hex(color)
      : (chalkInstance as any)[color];

  if (typeof fn !== `function`)
    throw new Error(`Invalid format type ${color}`);

  return fn(value);
}

export function pretty<T extends Type>(configuration: Configuration, value: Source<T>, formatType: T | string): string {
  if (value === null)
    return applyColor(configuration, `null`, Type.NULL);

  if (Object.prototype.hasOwnProperty.call(transforms, formatType)) {
    const transform = transforms[formatType as keyof typeof transforms];
    const typedTransform = transform as Extract<typeof transform, {pretty: (configuration: Configuration, val: Source<T>) => any}>;
    return typedTransform.pretty(configuration, value);
  }

  if (typeof value !== `string`)
    throw new Error(`Assertion failed: Expected the value to be a string, got ${typeof value}`);

  return applyColor(configuration, value, formatType);
}

export function prettyList<T extends Type>(configuration: Configuration, values: Iterable<Source<T>>, formatType: T | string, {separator = `, `}: {separator?: string} = {}): string {
  return [...values].map(value => pretty(configuration, value, formatType)).join(separator);
}

export function json<T extends Type>(value: Source<T>, formatType: T | string): any {
  if (value === null)
    return null;

  if (Object.prototype.hasOwnProperty.call(transforms, formatType)) {
    miscUtils.overrideType<keyof AllTransforms>(formatType);
    return transforms[formatType].json(value as never);
  }

  if (typeof value !== `string`)
    throw new Error(`Assertion failed: Expected the value to be a string, got ${typeof value}`);

  return value;
}