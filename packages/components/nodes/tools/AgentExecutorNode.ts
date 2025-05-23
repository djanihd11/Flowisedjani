// --- File: packages/components/nodes/tools/AgentExecutorNode.ts ---

import { INode, INodeData, INodeParams, ICommonObject, INodeOptionsValue } from '../../../src/Interface';
import { getBaseClasses } from '../../../src/utils';
import { StructuredTool, ToolParams } from '@langchain/core/tools';
import { z } from 'zod';

// Import backend libraries (ensure these are correctly installed in the Docker image)
import { execa, ExecaChildProcess } from 'execa'; // Make sure 'execa' is version 8+ for ESM, or handle accordingly
import fs from 'fs-extra';
import Docker from 'dockerode'; // Default export
import { Client as SSHClient, ClientChannel } from 'ssh2'; // Named exports

// 1. Define the Zod schema for the input to the Langchain tool's _call method
// This schema remains the same as the tool itself still expects a generic actionParams object.
// The AgentExecutorNode_FlowiseWrapper will be responsible for constructing this object.
const agentExecutorSchema = z.object({
    actionType: z.enum(["filesystem", "executeCommand", "docker", "ssh", "pythonScript"]),
    actionParams: z.any().describe("Parameters specific to the action type, constructed by the Flowise node's init method")
});

// 2. Define the parameters for our Langchain tool constructor
interface AgentExecutorToolParams extends ToolParams {
    // No specific params needed for constructor for now
}

// 3. Create the Langchain Tool class (AgentExecutorLangchainTool)
// This class remains largely the same as provided in the issue.
// It's the core logic unit that performs actions.
class AgentExecutorLangchainTool extends StructuredTool<typeof agentExecutorSchema> {
    static lc_name() {
        return 'AgentExecutorLangchainTool';
    }

    name = "agentExecutor";
    description = "Executes advanced system commands, interacts with Docker/SSH, and runs Python scripts, with parameters assembled by the Flowise node.";
    schema = agentExecutorSchema;

    constructor(params?: AgentExecutorToolParams) {
        super(params);
    }

    async _call(inputs: z.infer<typeof agentExecutorSchema>): Promise<string> {
        const { actionType, actionParams } = inputs;
        let result: any;

        try {
            switch (actionType) {
                case 'filesystem':
                    result = await this.handleFilesystem(actionParams);
                    break;
                case 'executeCommand':
                    result = await this.handleExecuteCommand(actionParams);
                    break;
                case 'docker':
                    result = await this.handleDocker(actionParams);
                    break;
                case 'ssh':
                    result = await this.handleSsh(actionParams);
                    break;
                case 'pythonScript':
                    result = await this.handlePythonScript(actionParams);
                    break;
                default:
                    // This case should ideally be caught by the Zod enum validation on actionType
                    const exhaustiveCheck: never = actionType;
                    throw new Error(`Unsupported actionType: ${exhaustiveCheck}`);
            }
            return JSON.stringify(result, null, 2);
        } catch (error: any) {
            console.error(`Error in AgentExecutorLangchainTool (${actionType}):`, error);
            // Return a structured error message
            return JSON.stringify({ 
                error: error.message, 
                details: error.stack, 
                actionType: actionType, 
                actionParams: actionParams // Include params for debugging
            }, null, 2);
        }
    }

    private async handleExecuteCommand(params: any): Promise<any> {
        if (!params.command) {
            throw new Error('Missing "command" parameter for executeCommand');
        }
        const { command, args = [], options = {} } = params;
        const execaOptions = { ...options, windowsHide: true };

        try {
            const { stdout, stderr, exitCode, failed, timedOut, isCanceled } = await execa(command, args, execaOptions);
            return { stdout, stderr, exitCode, failed, timedOut, isCanceled };
        } catch (error: any) { // execa throws an error that includes these properties
            return {
                stdout: error.stdout,
                stderr: error.stderr,
                exitCode: error.exitCode,
                failed: error.failed,
                timedOut: error.timedOut,
                isCanceled: error.isCanceled,
                error: error.shortMessage || error.message // use shortMessage if available
            };
        }
    }

    private async handleFilesystem(params: any): Promise<any> {
        const { operation, path, content, encoding = 'utf8' } = params;
        if (!operation || !path) {
            throw new Error('Missing "operation" or "path" for filesystem action');
        }

        switch (operation) {
            case 'readFile':
                return fs.readFile(path, encoding);
            case 'writeFile':
                if (content === undefined) throw new Error('Missing "content" for writeFile');
                await fs.writeFile(path, content, encoding);
                return { success: true, path, message: `File ${path} written successfully.` };
            case 'deleteFile':
                await fs.remove(path); // fs-extra's remove handles files and directories
                return { success: true, path, message: `Path ${path} deleted successfully.` };
            case 'listDir':
                return fs.readdir(path);
            case 'pathExists':
                return { exists: await fs.pathExists(path), path };
            default:
                const exhaustiveCheck: never = operation;
                throw new Error(`Unsupported filesystem operation: ${exhaustiveCheck}`);
        }
    }
    
    private async handleDocker(params: any): Promise<any> {
        const docker = new Docker(); // Assumes Docker socket is at /var/run/docker.sock or DOCKER_HOST env var
        const { operation, containerId, command, options = {}, listAll = false } = params;

        if (!operation) throw new Error('Missing "operation" for docker action');

        switch(operation) {
            case 'listContainers':
                return docker.listContainers({ all: listAll });
            case 'inspectContainer':
                if (!containerId) throw new Error('Missing "containerId" for inspectContainer');
                return docker.getContainer(containerId).inspect();
            case 'execInContainer':
                if (!containerId || !command) throw new Error('Missing "containerId" or "command" for execInContainer');
                const container = docker.getContainer(containerId);
                const exec = await container.exec({
                    Cmd: Array.isArray(command) ? command : command.split(' '), // Ensure command is an array
                    AttachStdout: true,
                    AttachStderr: true,
                    Tty: false, // Usually false for non-interactive exec
                    ...options // User-provided options like User, WorkingDir
                });
                return new Promise((resolve, reject) => {
                    exec.start({ hijack: true, stdin: false }, (err: Error | null, stream: NodeJS.ReadWriteStream | undefined) => {
                        if (err) return reject(err);
                        
                        let stdoutOutput = '';
                        // let stderrOutput = ''; // Docker stream demuxing needed for true separation here

                        if (stream) {
                            // Simplified stream handling: combines stdout/stderr from Docker exec.
                            // For true separation, Docker.modem.demuxStream() and separate WritableStreams are needed.
                            stream.on('data', (chunk) => {
                                stdoutOutput += chunk.toString('utf8'); 
                            });
                            stream.on('end', () => {
                                // Inspect exec for exit code AFTER stream ends
                                exec.inspect((inspectErr, data) => {
                                    if (inspectErr) return reject(inspectErr); 
                                    resolve({ 
                                        output: stdoutOutput.trim(), 
                                        // Stderr is not reliably captured separately with this simple stream handling for exec.
                                        stderr: data?.ExitCode !== 0 ? "Error likely occurred (see output, exit code for details)" : "", 
                                        exitCode: data?.ExitCode 
                                    });
                                });
                            });
                            stream.on('error', (errStream: Error) => reject(errStream));
                        } else {
                            reject(new Error("Stream not available for exec"));
                        }
                    });
                });
            default:
                const exhaustiveCheck: never = operation;
                throw new Error(`Unsupported docker operation: ${exhaustiveCheck}`);
        }
    }

    private async handleSsh(params: any): Promise<any> {
        const { host, port = 22, username, password, privateKey, command } = params;
        if (!host || !username || (!password && !privateKey) || !command) {
            throw new Error('Missing required SSH parameters (host, username, auth method, command)');
        }

        return new Promise((resolve, reject) => {
            const conn = new SSHClient();
            conn.on('ready', () => {
                conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
                    if (err) {
                        conn.end();
                        return reject(err);
                    }
                    let output = '';
                    let stderrOutput = '';
                    stream.on('close', (code: number | null, signal: string | undefined) => {
                        conn.end();
                        resolve({ output: output.trim(), stderr: stderrOutput.trim(), code, signal });
                    }).on('data', (data: Buffer) => {
                        output += data.toString('utf8');
                    }).stderr.on('data', (data: Buffer) => {
                        stderrOutput += data.toString('utf8');
                    });
                });
            }).on('error', (err: Error) => { // Handle connection errors
                reject(err);
            }).connect({ 
                host, 
                port, 
                username, 
                password, 
                privateKey: privateKey ? (typeof privateKey === 'string' ? privateKey : privateKey.toString('utf8')) : undefined 
            });
        });
    }
    
    private async handlePythonScript(params: any): Promise<any> {
        const { scriptContent, scriptPath, args = [] } = params; 
        let finalScriptPath = scriptPath;
        let tempScriptWritten = false;

        if (scriptContent) { 
            finalScriptPath = `/tmp/flowise_python_script_${Date.now()}.py`;
            await fs.writeFile(finalScriptPath, scriptContent);
            tempScriptWritten = true;
        }

        if (!finalScriptPath) {
            throw new Error('Missing "scriptContent" (direct script) or "scriptPath" for pythonScript action');
        }

        try {
            const { stdout, stderr, exitCode } = await execa('python3', [finalScriptPath, ...args]);
            return { stdout, stderr, exitCode };
        } catch (error: any) {
            return { 
                stdout: error.stdout, 
                stderr: error.stderr, 
                exitCode: error.exitCode, 
                error: error.shortMessage || error.message 
            };
        } finally {
            if (tempScriptWritten && finalScriptPath) {
                await fs.remove(finalScriptPath).catch(e => console.error("Failed to cleanup temp python script:", finalScriptPath, e));
            }
        }
    }
}

// 4. Create the Flowise Node class (AgentExecutorNode_FlowiseWrapper)
class AgentExecutorNode_FlowiseWrapper implements INode {
    label: string;
    name: string;
    version: number;
    description: string;
    type: string;
    icon: string;
    category: string;
    baseClasses: string[];
    inputs: INodeParams[];
    constructor() {
        this.label = 'Agent Executor V2'; 
        this.name = 'agentExecutorNodeV2'; 
        this.version = 2.0;
        this.type = 'AgentExecutorV2'; 
        this.icon = 'customtool.svg'; 
        this.category = 'Tools';
        this.description = 'Dynamically executes system actions (files, commands, Docker, SSH, Python) with context-aware parameters.';
        this.baseClasses = [this.type, 'Tool', ...getBaseClasses(AgentExecutorLangchainTool)];

        const actionTypeOptions: INodeOptionsValue[] = [
            { label: 'Filesystem', name: 'filesystem' },
            { label: 'Execute Command', name: 'executeCommand' },
            { label: 'Docker Operation', name: 'docker' },
            { label: 'SSH Command', name: 'ssh' },
            { label: 'Python Script', name: 'pythonScript' }
        ];

        this.inputs = [
            {
                label: 'Action Type',
                name: 'actionType', // This name must match a key in agentExecutorSchema
                type: 'options',
                options: actionTypeOptions,
                description: 'The type of action to perform.',
                defaultValue: 'filesystem' 
            },

            // --- Filesystem Inputs ---
            {
                label: 'FS Operation',
                name: 'fsOperation',
                type: 'options',
                options: [
                    { label: 'Read File', name: 'readFile' },
                    { label: 'Write File', name: 'writeFile' },
                    { label: 'Delete Path', name: 'deleteFile' },
                    { label: 'List Directory', name: 'listDir' },
                    { label: 'Path Exists', name: 'pathExists' }
                ],
                show: { 'inputs.actionType': 'filesystem' },
                defaultValue: 'readFile'
            },
            {
                label: 'FS Path',
                name: 'fsPath',
                type: 'string',
                placeholder: '/path/to/file_or_dir',
                show: { 'inputs.actionType': 'filesystem' }
            },
            {
                label: 'FS Content',
                name: 'fsContent',
                type: 'string',
                rows: 4,
                placeholder: 'Content to write into the file...',
                show: { 'inputs.actionType': 'filesystem', 'inputs.fsOperation': 'writeFile' }
            },
            {
                label: 'FS Encoding',
                name: 'fsEncoding',
                type: 'string',
                optional: true,
                placeholder: 'utf8',
                show: { 'inputs.actionType': 'filesystem', 'inputs.fsOperation': ['readFile', 'writeFile'] }
            },

            // --- Execute Command Inputs ---
            {
                label: 'Command',
                name: 'execCommand',
                type: 'string',
                placeholder: 'ls',
                show: { 'inputs.actionType': 'executeCommand' }
            },
            {
                label: 'Arguments (JSON Array)',
                name: 'execArgs',
                type: 'json', 
                optional: true,
                placeholder: '["-la", "/app"]',
                description: 'A JSON array of strings for arguments.',
                show: { 'inputs.actionType': 'executeCommand' }
            },
            {
                label: 'Exec Options (JSON)',
                name: 'execOptions',
                type: 'json', 
                optional: true,
                placeholder: '{\"cwd\": \"/tmp\"}', 
                description: 'JSON object of execa options (e.g., cwd, env).',
                show: { 'inputs.actionType': 'executeCommand' }
            },

            // --- Docker Operation Inputs ---
            {
                label: 'Docker Operation',
                name: 'dockerOperation',
                type: 'options',
                options: [
                    { label: 'List Containers', name: 'listContainers' },
                    { label: 'Inspect Container', name: 'inspectContainer' },
                    { label: 'Exec in Container', name: 'execInContainer' }
                ],
                show: { 'inputs.actionType': 'docker' },
                defaultValue: 'listContainers'
            },
            {
                label: 'Docker List All Containers',
                name: 'dockerListAll',
                type: 'boolean',
                optional: true,
                defaultValue: false,
                show: { 'inputs.actionType': 'docker', 'inputs.dockerOperation': 'listContainers' }
            },
            {
                label: 'Docker Container ID/Name',
                name: 'dockerContainerId',
                type: 'string',
                placeholder: 'my_container_id_or_name',
                show: { 'inputs.actionType': 'docker', 'inputs.dockerOperation': ['inspectContainer', 'execInContainer'] }
            },
            {
                label: 'Docker Exec Command (JSON Array or String)',
                name: 'dockerCommand',
                type: 'string', 
                placeholder: 'ps aux OR ["ps", "aux"]',
                description: 'Command for exec. Can be a single string or a JSON array of strings (e.g., [\"echo\", \"hello\"]).',
                show: { 'inputs.actionType': 'docker', 'inputs.dockerOperation': 'execInContainer' }
            },
            {
                label: 'Docker Exec Options (JSON)',
                name: 'dockerExecOptions',
                type: 'json', 
                optional: true,
                placeholder: '{\"User\": \"root\"}',
                description: 'JSON object of options for docker exec (e.g., User, WorkingDir, Env).',
                show: { 'inputs.actionType': 'docker', 'inputs.dockerOperation': 'execInContainer' }
            },

            // --- SSH Command Inputs ---
            {
                label: 'SSH Host',
                name: 'sshHost',
                type: 'string',
                placeholder: 'your.ssh.server.com',
                show: { 'inputs.actionType': 'ssh' }
            },
            {
                label: 'SSH Port',
                name: 'sshPort',
                type: 'number',
                optional: true,
                defaultValue: 22,
                show: { 'inputs.actionType': 'ssh' }
            },
            {
                label: 'SSH Username',
                name: 'sshUsername',
                type: 'string',
                placeholder: 'user',
                show: { 'inputs.actionType': 'ssh' }
            },
            {
                label: 'SSH Password',
                name: 'sshPassword',
                type: 'password',
                optional: true,
                show: { 'inputs.actionType': 'ssh' }
            },
            {
                label: 'SSH Private Key',
                name: 'sshPrivateKey',
                type: 'string',
                rows: 5,
                optional: true,
                placeholder: '-----BEGIN RSA PRIVATE KEY-----\n...',
                description: 'Content of the private key file.',
                show: { 'inputs.actionType': 'ssh' }
            },
            {
                label: 'SSH Command',
                name: 'sshCommand',
                type: 'string',
                placeholder: 'ls -la /home/user',
                show: { 'inputs.actionType': 'ssh' }
            },

            // --- Python Script Inputs ---
            {
                label: 'Python Script Content',
                name: 'pythonScriptContent',
                type: 'string',
                rows: 8,
                optional: true,
                placeholder: 'import os\nprint(os.getcwd())',
                description: 'Directly enter Python script content here. If provided, this takes precedence over Script Path.',
                show: { 'inputs.actionType': 'pythonScript' }
            },
            {
                label: 'Python Script Path',
                name: 'pythonScriptPath',
                type: 'string',
                optional: true,
                placeholder: '/app/scripts/my_script.py',
                description: 'Full path to the Python script file in the container. Used if Script Content is empty.',
                show: { 'inputs.actionType': 'pythonScript' }
            },
            {
                label: 'Python Arguments (JSON Array)',
                name: 'pythonArgs',
                type: 'json', 
                optional: true,
                placeholder: '["arg1", "123"]',
                description: 'A JSON array of strings for script arguments.',
                show: { 'inputs.actionType': 'pythonScript' }
            }
        ];
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const actionType = nodeData.inputs?.actionType as string;
        const actionParams: ICommonObject = {}; 

        const parseJsonInput = (input: any, fieldName: string): any => {
            if (input === undefined || input === null) return undefined;
            if (typeof input === 'string' && input.trim() === '') return undefined;
            if (typeof input === 'string') {
                try {
                    return JSON.parse(input);
                } catch (e: any) {
                    throw new Error(`Invalid JSON in ${fieldName}: ${e.message}. Input was: "${input}"`);
                }
            }
            return input; 
        };

        switch (actionType) {
            case 'filesystem':
                actionParams.operation = nodeData.inputs?.fsOperation as string;
                actionParams.path = nodeData.inputs?.fsPath as string;
                if (nodeData.inputs?.fsOperation === 'writeFile') {
                    actionParams.content = nodeData.inputs?.fsContent as string;
                }
                if (nodeData.inputs?.fsEncoding && (nodeData.inputs?.fsOperation === 'readFile' || nodeData.inputs?.fsOperation === 'writeFile')) {
                    actionParams.encoding = nodeData.inputs?.fsEncoding as string;
                }
                break;
            case 'executeCommand':
                actionParams.command = nodeData.inputs?.execCommand as string;
                actionParams.args = parseJsonInput(nodeData.inputs?.execArgs, 'Exec Arguments') || [];
                actionParams.options = parseJsonInput(nodeData.inputs?.execOptions, 'Exec Options') || {};
                break;
            case 'docker':
                actionParams.operation = nodeData.inputs?.dockerOperation as string;
                if (actionParams.operation === 'listContainers') { // Check specific operation for listAll
                    actionParams.listAll = nodeData.inputs?.dockerListAll as boolean;
                }
                if (actionParams.operation === 'inspectContainer' || actionParams.operation === 'execInContainer') {
                    actionParams.containerId = nodeData.inputs?.dockerContainerId as string;
                }
                if (actionParams.operation === 'execInContainer') {
                    const cmdInput = nodeData.inputs?.dockerCommand as string;
                    if (cmdInput) { 
                        try {
                            actionParams.command = JSON.parse(cmdInput); 
                        } catch (e) {
                            actionParams.command = cmdInput; 
                        }
                    } else {
                        actionParams.command = []; 
                    }
                    actionParams.options = parseJsonInput(nodeData.inputs?.dockerExecOptions, 'Docker Exec Options') || {};
                }
                break;
            case 'ssh':
                actionParams.host = nodeData.inputs?.sshHost as string;
                actionParams.port = nodeData.inputs?.sshPort as number || 22;
                actionParams.username = nodeData.inputs?.sshUsername as string;
                actionParams.password = nodeData.inputs?.sshPassword as string; 
                actionParams.privateKey = nodeData.inputs?.sshPrivateKey as string; 
                actionParams.command = nodeData.inputs?.sshCommand as string;
                break;
            case 'pythonScript':
                actionParams.scriptContent = nodeData.inputs?.pythonScriptContent as string;
                actionParams.scriptPath = nodeData.inputs?.pythonScriptPath as string;
                actionParams.args = parseJsonInput(nodeData.inputs?.pythonArgs, 'Python Arguments') || [];
                break;
            default:
                const exhaustiveCheck: never = actionType; // Should be caught by Zod enum on actionType
                throw new Error(`Unknown actionType in init: ${exhaustiveCheck}`);
        }
        
        // Instantiate the tool with the top-level options (like credentials)
        const toolInstance = new AgentExecutorLangchainTool(options); // Corrected line

        // This step is crucial for Flowise to correctly pass the assembled `actionParams`
        // to the tool's `_call` method, given that `actionParams` is not a direct UI input
        // but is defined in the tool's schema. We are effectively pre-populating
        // the `actionParams` field that Flowise will look for in `nodeData.inputs`
        // when preparing the arguments for `tool.call()`.
        if (nodeData.inputs) {
            (nodeData.inputs as ICommonObject)['actionParams'] = actionParams;
        } else {
            // This is a fallback, ideally nodeData.inputs should always exist.
            // If nodeData.inputs is undefined, we create it to hold actionParams and actionType.
            (nodeData as INodeData).inputs = { actionParams: actionParams, actionType: actionType };
        }
        
        return toolInstance;
    }
}

module.exports = { nodeClass: AgentExecutorNode_FlowiseWrapper };
