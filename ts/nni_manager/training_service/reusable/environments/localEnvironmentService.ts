// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as tkill from 'tree-kill';
import * as component from '../../../common/component';
import { getExperimentId } from '../../../common/experimentStartupInfo';
import { getLogger, Logger } from '../../../common/log';
import { TrialConfigMetadataKey } from '../../common/trialConfigMetadataKey';
import { EnvironmentInformation, EnvironmentService } from '../environment';
import { TrialConfig } from '../../common/trialConfig';
import { getExperimentRootDir, isAlive, getNewLine } from '../../../common/utils';
import { execMkdir, runScript, getScriptName, execCopydir } from '../../common/util';

@component.Singleton
export class LocalEnvironmentService extends EnvironmentService {

    private readonly log: Logger = getLogger();
    private localTrialConfig: TrialConfig | undefined;
    private experimentRootDir: string;
    private experimentId: string;

    constructor() {
        super();
        this.experimentId = getExperimentId();
        this.experimentRootDir = getExperimentRootDir();
    }

    public get environmentMaintenceLoopInterval(): number {
        return 100;
    }

    public get hasStorageService(): boolean {
        return false;
    }

    public get getName(): string {
        return 'local';
    }

    public async config(key: string, value: string): Promise<void> {
        switch (key) {
            case TrialConfigMetadataKey.TRIAL_CONFIG:
                this.localTrialConfig = <TrialConfig>JSON.parse(value);
                break;
            default:
                this.log.debug(`Local mode does not proccess metadata key: '${key}', value: '${value}'`);
        }
    }

    public async refreshEnvironmentsStatus(environments: EnvironmentInformation[]): Promise<void> {
        environments.forEach(async (environment) => {
            const jobpidPath: string = `${path.join(environment.runnerWorkingFolder, 'pid')}`;
            const runnerReturnCodeFilePath: string = `${path.join(environment.runnerWorkingFolder, 'code')}`;
            /* eslint-disable require-atomic-updates */
            try {
                // check if pid file exist
                const pidExist = await fs.existsSync(jobpidPath);
                if (!pidExist) {
                    return;
                }
                const pid: string = await fs.promises.readFile(jobpidPath, 'utf8');
                const alive: boolean = await isAlive(pid);
                environment.status = 'RUNNING';
                // if the process of jobpid is not alive any more
                if (!alive) {
                    if (fs.existsSync(runnerReturnCodeFilePath)) {
                        const runnerReturnCode: string = await fs.promises.readFile(runnerReturnCodeFilePath, 'utf8');
                        const match: RegExpMatchArray | null = runnerReturnCode.trim()
                            .match(/^-?(\d+)\s+(\d+)$/);
                        if (match !== null) {
                            const { 1: code } = match;
                            // Update trial job's status based on result code
                            if (parseInt(code, 10) === 0) {
                                environment.setStatus('SUCCEEDED');
                            } else {
                                environment.setStatus('FAILED');
                            }
                        }
                    }
                }
            } catch (error) {
                this.log.error(`Update job status exception, error is ${error.message}`);
            }
        });
    }
    
    private getScript(environment: EnvironmentInformation): string[] {
        const script: string[] = [];
        if (process.platform === 'win32') {
            script.push(`cd $env:${this.experimentRootDir}`);
            script.push(`New-Item -ItemType "directory" -Path ${path.join(this.experimentRootDir, 'envs', environment.id)} -Force`);
            environment.command = `cd envs\\${environment.id} && python -m nni.tools.trial_tool.trial_runner`;
            script.push(
                `cmd.exe /c ${environment.command} --job_pid_file ${path.join(environment.runnerWorkingFolder, 'pid')} 2>&1 | Out-File "${path.join(environment.runnerWorkingFolder, 'trial_runner.log')}" -encoding utf8`,
                `$NOW_DATE = [int64](([datetime]::UtcNow)-(get-date "1/1/1970")).TotalSeconds`,
                `$NOW_DATE = "$NOW_DATE" + (Get-Date -Format fff).ToString()`,
                `Write $LASTEXITCODE " " $NOW_DATE  | Out-File "${path.join(environment.runnerWorkingFolder, 'code')}" -NoNewline -encoding utf8`);
        } else {
            script.push(`cd ${this.experimentRootDir}`);
            script.push(`eval ${environment.command} --job_pid_file ${environment.runnerWorkingFolder}/pid 1>${environment.runnerWorkingFolder}/trialrunner_stdout 2>${environment.runnerWorkingFolder}/trialrunner_stderr"`);
            if (process.platform === 'darwin') {
                // https://superuser.com/questions/599072/how-to-get-bash-execution-time-in-milliseconds-under-mac-os-x
                // Considering the worst case, write 999 to avoid negative duration
                script.push(`echo $? \`date +%s999\` >'${environment.runnerWorkingFolder}/code'`);
            } else {
                script.push(`echo $? \`date +%s%3N\` >'${environment.runnerWorkingFolder}/code'`);
            }
        }

        return script;
    }

    public async startEnvironment(environment: EnvironmentInformation): Promise<void> {
        if (this.localTrialConfig === undefined) {
            throw new Error('Local trial config is not initialized');
        }
        // Need refactor, this temp folder path is not appropriate, there are two expId in this path
        const localTempFolder: string = path.join(this.experimentRootDir, this.experimentId,
            "environment-temp", "envs");
        const localEnvCodeFolder: string = path.join(this.experimentRootDir, "envs");
        environment.runnerWorkingFolder = path.join(localEnvCodeFolder, environment.id);
        await execMkdir(environment.runnerWorkingFolder);
        await execCopydir(localTempFolder, localEnvCodeFolder);
        environment.command = this.getScript(environment).join(getNewLine());
        const scriptName: string = getScriptName('run');
        await fs.promises.writeFile(path.join(localEnvCodeFolder, scriptName),
                                    environment.command, { encoding: 'utf8', mode: 0o777 });

        // Execute command in local machine
        runScript(path.join(localEnvCodeFolder, scriptName));
        environment.trackingUrl = `${environment.runnerWorkingFolder}`;
    }

    public async stopEnvironment(environment: EnvironmentInformation): Promise<void> {
        if (environment.isAlive === false) {
            return Promise.resolve();
        }

        const jobpidPath: string = `${path.join(environment.runnerWorkingFolder, 'pid')}`;
        const pid: string = await fs.promises.readFile(jobpidPath, 'utf8');
        tkill(Number(pid), 'SIGKILL');
    }
}
