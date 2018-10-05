import * as fs from 'fs';
import { resolve } from 'path';
import { promisify } from 'util';
import streamReplace from 'stream-replace';
import { Homefront } from 'homefront';
import { exec, spawn } from 'child_process';
import rimraf from 'rimraf';
import mkdirp from 'mkdirp';
import glob from 'glob';

export type ConfigType = Partial<{
  sourceDirectory: string,
  targetDirectory: string,
  sourceFile: string,
  targetFile: string,
}>;

export type ModifyType = Partial<{
  append: string,
  prepend: string,
  replace: string,
  custom: Function,
}>;

export type StreamType = fs.ReadStream | fs.WriteStream;

export class TapeRoller {
  private readonly sourceDirectory?: string;

  private sourceFile?: string;

  private readonly targetDirectory?: string;

  private targetFile?: string;

  private stream?: StreamType;

  constructor ({ sourceDirectory, targetDirectory, sourceFile, targetFile }: ConfigType = {}) {
    this.sourceDirectory = sourceDirectory;
    this.targetDirectory = targetDirectory;
    this.sourceFile      = sourceFile;
    this.targetFile      = targetFile;
  }

  private static resolvePath (dir?: string, file?: string): string {
    return resolve(process.cwd(), dir || '', file || '');
  }

  public static async fromGlob (pattern: string, options?: { [key: string]: any }, targetDirectory?: string): Promise<TapeRoller[]> {
    const asyncGlob = promisify(glob);
    const files     = await asyncGlob(pattern, options);

    return files.map(sourceFile => new TapeRoller({ targetDirectory, sourceFile }));
  }

  public rename (oldPath: string, newPath: string): this {
    fs.renameSync(oldPath, newPath);

    return this;
  }

  public read (file?: string): this {
    if (file) {
      this.sourceFile = file;
    }

    if (!this.sourceFile) {
      throw new Error('No source file provided');
    }

    const path = TapeRoller.resolvePath(this.sourceDirectory, this.sourceFile);

    this.stream = fs.createReadStream(path);

    this.stream.on('error', (error) => console.error('Read error: ', error));

    return this;
  }

  public write (file?: string, temp?: boolean): this {
    if (file) {
      this.targetFile = file;
    }

    const fileName = temp ? `__temp__${this.targetFile}` : this.targetFile;
    const path     = TapeRoller.resolvePath(this.targetDirectory);
    const fullPath = `${path}/${fileName}`;

    mkdirp.sync(this.targetDirectory);

    this.stream = this.stream.pipe(fs.createWriteStream(fullPath));

    this.stream.on('error', (error) => console.error('Write error: ', error));

    if (temp) {
      this.stream.on('close', () => {
        this.rename(fullPath, `${path}/${this.targetFile}`);
      });
    }

    return this;
  }

  public copy (source?: string, target?: string): this {
    if (source) {
      this.sourceFile = source;
    }

    if (target) {
      this.targetFile = target;
    }

    if (!this.stream) {
      this.read();
    }

    this.write();

    return this;
  }

  public replace (parameters: { [key: string]: any }) {
    if (!this.stream) {
      this.read();
    }

    const params  = new Homefront(parameters);
    const regex   = /{{\s?([\w.]+)(?:(?:\s?:\s?)(?:(?:['"]?)(.*?)(?:['"]?)))?\s?}}/gi;
    const replace = (match: string, parameter: string, defaultValue: string): string => {
      return params.fetch(parameter) || defaultValue || match;
    };

    this.stream = this.stream.pipe(this.applyModify(regex, { custom: replace }));

    return this;
  }

  public modify (pattern: RegExp, { append, prepend, custom, replace }: ModifyType): this {
    if (!this.stream) {
      this.read();
    }

    this.stream = this.stream.pipe(this.applyModify(pattern, { append, prepend, custom, replace }));

    return this;
  }

  private applyModify (pattern: RegExp, { append, prepend, custom, replace }: ModifyType): fs.WriteStream {
    return streamReplace(pattern, (match: string, parameter: string, defaultValue: string): string => {
      if (typeof replace !== 'undefined') {
        return replace;
      }

      if (typeof append !== 'undefined') {
        return match + append;
      }

      if (typeof prepend !== 'undefined') {
        return prepend + match;
      }

      if (typeof custom === 'function') {
        return custom(match, parameter, defaultValue);
      }

      return match;
    });
  }

  public clone (repository: string, projectName?: string, cwd: string = null) {
    const args = ['clone', repository];

    if (projectName) {
      args.push(projectName);
    }

    const process = spawn('git', args, { cwd });
    const name    = projectName || repository.match(/\/([\w-_]+)\.git$/)[1];
    const path    = cwd ? `./${cwd}/${name}` : `./${name}`;

    process.on('close', (status: number) => {
      if (status !== 0) {
        return;
      }

      this.remove(`${path}/.git`, true);
      this.installDependencies(path);
    });

    process.on('error', (error: { code: string }) => {
      console.log('Could not clone repository ' + repository);
    });

    return this;
  }

  private installDependencies (path: string): this {
    const process = exec(`yarn --cwd ${path} install`);

    process.on('close', (status: number) => {
      if (status !== 0) {
        return;
      }

      console.log('Installed dependencies');
      return this;
    });

    process.on('error', () => {
      console.error('Could not install dependencies');
    });

    return this;
  }

  private removeFile (path: string): this {
    const errorCodes: string[] = ['EPERM', 'EISDIR'];

    fs.unlink(path, (error) => {
      if (error) {
        if (errorCodes.includes(error.code)) {
          throw new Error('Cannot remove directory if recursive is false');
        }

        return console.error(error);
      }

      return console.log('Removed file ' + path);
    });

    return this;
  }

  private removeDir (path: string): this {
    rimraf(path, (error) => {
      if (error) {
        console.error(error);
      }
    });

    return this;
  }

  public remove (path: string, recursive: boolean = false): this {
    const resolvedPath = TapeRoller.resolvePath(path);

    if (!recursive) {
      return this.removeFile(resolvedPath);
    }

    return this.removeDir(resolvedPath);
  }
}
