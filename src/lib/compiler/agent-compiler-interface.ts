import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { AgentCompiler } from '.';

export interface ParameterConfig {
  name: string;
  type: string;
  description: string;
  required: boolean;
  defaultValue?: unknown;
}

export interface ToolConfig {
  name: string;
  description: string;
  parameters: ParameterConfig[];
  implementation: string;
  returnType: string;
}

export interface ResourceConfig {
  name: string;
  type: 'text' | 'binary' | 'json';
  content: string | Buffer;
  isEmbedded: boolean;
}

export interface PromptConfig {
  name: string;
  content: string;
  variables: string[];
}

export interface TEEConfig {
  isolationLevel: 'process' | 'container' | 'vm';
  resourceLimits: {
    memory: number; // MB
    cpu: number; // cores
    timeLimit: number; // seconds
  };
  networkAccess: boolean;
  fileSystemAccess: boolean;
}

export interface AgentPluginConfig {
  // W3C DID Core compliant globally unique decentralized identifier
  agent_id: string;
  // Human-readable alias encoded as a URN (e.g., urn:agent:salesforce:starbucks)
  agent_name: string;
  // Agent type classification
  agentType: 'llm' | 'sequential' | 'parallel' | 'loop';
  // Human-readable description
  description: string;
  // Version information
  version: string;
  // Reference to the AgentFacts hosted at the agent's domain
  facts_url: string; // e.g., https://salesforce.com/starbucks/.agent-facts
  // Optional privacy-enhanced reference to AgentFacts on third-party or decentralized service
  private_facts_url?: string; // e.g., https://agentfacts.nanda.ai/...
  // Optional endpoint for dynamic routing services
  adaptive_router_url?: string; // e.g., https://router.example.com/dispatch
  // Maximum cache duration before client must re-resolve the record
  ttl: number; // in seconds
  // Cryptographic signature from registry resolver
  signature: string;
  // Build target for compilation
  buildTarget?: 'wasm' | 'go';
  // Tool configurations
  tools: ToolConfig[];
  // Resource configurations
  resources: ResourceConfig[];
  // Prompt configurations
  prompts: PromptConfig[];
  // Python dependencies
  pythonDependencies: string[];
  // Whether to use chromem-go for persistence
  useChromemGo: boolean;
  // Whether the agent can spawn sub-agents
  subAgentCapabilities: boolean;
  // TEE configuration
  trustedExecutionEnvironment: TEEConfig;
}

interface MCPServerConfig {
  url: string;
  name: string;
  enabled: boolean;
}

interface UIConfig {
  name: string;
  // Optional agent_name property that can be provided by the UI
  agent_name?: string;
  personality: string;
  instructions: string;
  features: Record<string, unknown>;
  apiKeys?: {
    openai: string;
    anthropic: string;
    google: string;
    cerebras: string;
    deepseek: string;
  };
  settings: {
    mcpServers: MCPServerConfig[];
    creativity?: number;
  };
  tools?: ToolConfig[];
  resources?: Array<{
    name: string;
    type: 'text' | 'binary' | 'json';
    content: string;
    isEmbedded: boolean;
  }>;
}

/**
 * Interface for the Agent Compiler Service
 * This service is responsible for compiling agent configurations into plugin binaries
 */
export interface AgentCompilerService {
  /**
   * Compiles an agent configuration into a plugin binary
   * @param config The agent configuration
   * @returns A promise that resolves to the path of the compiled plugin
   */
  compileAgent(config: AgentPluginConfig): Promise<string>;
  
  /**
   * Converts a UI agent configuration to the compiler's AgentPluginConfig format
   * @param uiConfig The UI agent configuration
   * @returns The compiler's AgentPluginConfig
   */
  convertUIConfigToPluginConfig(uiConfig: unknown): AgentPluginConfig;
  
  /**
   * Gets the default template directory
   * @returns The path to the default template directory
   */
  getDefaultTemplateDir(): string;
  
  /**
   * Gets the default output directory
   * @returns The path to the default output directory
   */
  getDefaultOutputDir(): string;

  /**
   * Gets the compilation logs from the last compilation
   * @returns Array of log messages
   */
  getCompilationLogs(): string[];
}

/**
 * Factory function to create an instance of the AgentCompilerService
 * @returns An instance of the AgentCompilerService
 */
export async function createAgentCompilerService(): Promise<AgentCompilerService> {
  // Import the AgentCompiler class
  const { AgentCompiler } = await import('.');

  // Get the default directories
  // For Next.js, we need to adjust the paths
  const appRoot = process.cwd();
  const defaultTemplateDir = path.join(appRoot, 'src', 'lib', 'compiler', 'templates');

  // Use temporary directory for serverless environments
  let defaultOutputDir: string;
  if (process.env.NETLIFY || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    // In serverless environments, use /tmp directory
    defaultOutputDir = path.join('/tmp', 'agentify-output');
  } else {
    // In local development, use public/output
    defaultOutputDir = path.join(appRoot, 'public', 'output');
  }

  // Create the output directory if it doesn't exist
  try {
    if (!fs.existsSync(defaultOutputDir)) {
      fs.mkdirSync(defaultOutputDir, { recursive: true });
    }
  } catch (error) {
    console.warn('Could not create output directory:', error);
    // Fallback to /tmp if we can't create the directory
    defaultOutputDir = path.join('/tmp', 'agentify-output');
    if (!fs.existsSync(defaultOutputDir)) {
      fs.mkdirSync(defaultOutputDir, { recursive: true });
    }
  }

  // Create the compiler instance
  const compiler = new AgentCompiler(appRoot, defaultTemplateDir, defaultOutputDir);

  // Check toolchain availability
  const toolchain = await compiler.checkToolchain();
  if (!toolchain.go || !toolchain.python) {
    console.warn('⚠️  Missing toolchain components:', {
      go: toolchain.go ? '✅' : '❌',
      python: toolchain.python ? '✅' : '❌',
      gcc: toolchain.gcc ? '✅' : '❌'
    });

    // In development, we can try to install missing tools
    if (process.env.NODE_ENV !== 'production') {
      console.log('🛠️  Attempting to install missing tools...');
      try {
        await compiler.installToolchain();
      } catch (error) {
        console.error('❌ Failed to install toolchain:', error);
        console.log('ℹ️  Falling back to mock compilation mode');
      }
    }
  }
  
  return {
    compileAgent: (config: AgentPluginConfig) => compiler.compileAgent(config),
    
    convertUIConfigToPluginConfig: (uiConfig: unknown): AgentPluginConfig => {
      if (!uiConfig || typeof uiConfig !== 'object') {
        throw new Error('Invalid UI config');
      }
      const uiConfigObj = uiConfig as UIConfig;
      const {
        name: agentName,
        agent_name: existingAgentName, // Check if agent_name is already provided
        personality: agentPersonality,
        instructions: agentInstructions,
        features: agentFeatures,
        apiKeys: agentApiKeys,
        settings: agentSettings
      } = uiConfigObj;
      
      if (!agentName || !agentPersonality || !agentInstructions || !agentSettings) {
        throw new Error('Missing required UI config fields');
      }
      // Convert the UI configuration to the compiler's AgentPluginConfig format
      
      // Generate a unique ID for the agent
      const agentId = uuidv4();
      
      // Log the UI config for debugging
      console.log('Converting UI config to plugin config:', {
        hasName: !!agentName,
        hasExistingAgentName: !!existingAgentName,
        name: agentName,
        existingAgentName: existingAgentName
      });
      
      // Create the basic configuration
      const agentConfig: AgentPluginConfig = {
        agent_id: agentId,
        // CRITICAL FIX: Ensure agent_name is always defined
        // Use existing agent_name if provided, otherwise generate one from the name
        agent_name: existingAgentName || `urn:agent:agentify:${agentName.toLowerCase().replace(/\s+/g, '-')}`,
        agentType: 'llm',
        description: agentInstructions || `${agentName} is a helpful AI assistant.`,
        version: '1.0.0',
        facts_url: `https://agentify.example.com/agents/${agentId}`,
        ttl: 3600,
        signature: 'placeholder-signature', // This would be generated properly in production
        tools: [],
        resources: [],
        prompts: [],
        pythonDependencies: [],
        useChromemGo: true,
        subAgentCapabilities: false,
        trustedExecutionEnvironment: {
          isolationLevel: 'process',
          resourceLimits: {
            memory: 512,
            cpu: 1,
            timeLimit: 60
          },
          networkAccess: true,
          fileSystemAccess: false
        }
      };
      
      // Add features as tools
      if (agentFeatures) {
        if (agentFeatures.chat) {
          (agentConfig.tools ||= []).push({
            name: 'chat',
            description: 'Chat with the user',
            implementation: 'return { message: input }',
            parameters: [
              {
                name: 'input',
                type: 'string',
                description: 'The user input',
                required: true
              }
            ],
            returnType: 'object'
          });
        }
        
        if (agentFeatures.automation) {
          (agentConfig.tools ||= []).push({
            name: 'automate',
            description: 'Automate a task',
            implementation: 'return { success: true, taskId: "task-123" }',
            parameters: [
              {
                name: 'task',
                type: 'string',
                description: 'The task to automate',
                required: true
              }
            ],
            returnType: 'object'
          });
        }
        
        if (agentFeatures.analytics) {
          (agentConfig.tools ||= []).push({
            name: 'analyze',
            description: 'Analyze data',
            implementation: 'return { insights: ["Insight 1", "Insight 2"] }',
            parameters: [
              {
                name: 'data',
                type: 'string',
                description: 'The data to analyze',
                required: true
              }
            ],
            returnType: 'object'
          });
        }
      }
      
      // Add MCP servers as resources
      if (agentSettings && agentSettings.mcpServers) {
        const mcpServers = agentSettings.mcpServers;
        mcpServers.forEach((server, index) => {
          if (server.enabled) {
            (agentConfig.resources ||= []).push({
              name: `mcp_server_${index}`,
              type: 'json',
              content: JSON.stringify(server),
              isEmbedded: true
            });
          }
        });
      }
      
      // Set creativity as a parameter
      if (agentSettings && agentSettings.creativity !== undefined) {
        (agentConfig.resources ||= []).push({
          name: 'creativity_parameter',
          type: 'text',
          content: agentSettings.creativity.toString(),
          isEmbedded: true
        });
      }

      // Add API keys as a resource
      if (agentApiKeys) {
        (agentConfig.resources ||= []).push({
          name: 'api_keys',
          type: 'json',
          content: JSON.stringify(agentApiKeys),
          isEmbedded: true
        });
      }

      // Log the final agent config for debugging
      console.log('Final plugin config:', {
        agent_id: agentConfig.agent_id,
        agent_name: agentConfig.agent_name,
        hasAgentName: !!agentConfig.agent_name
      });

      return agentConfig;
    },
    
    getDefaultTemplateDir: () => defaultTemplateDir,

    getDefaultOutputDir: () => defaultOutputDir,

    getCompilationLogs: () => compiler.getCompilationLogs()
  };
}