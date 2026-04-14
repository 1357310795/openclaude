import * as Lark from '@larksuiteoapi/node-sdk'
import { randomUUID } from 'crypto'
import type { Interface as ReadLineInterface } from 'readline'
import { createInterface } from 'readline'
import { PassThrough } from 'stream'
import type { SDKUserMessage } from 'src/entrypoints/agentSdkTypes.js'
import type {
  SDKControlRequest,
  StdoutMessage,
} from 'src/entrypoints/sdk/controlTypes.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from 'src/tools/TodoWriteTool/constants.js'
import type { TodoList } from 'src/utils/todo/types.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { StructuredIO } from './structuredIO.js'

export type FeishuReceiveIdType =
  | 'chat_id'
  | 'open_id'
  | 'user_id'
  | 'union_id'
  | 'email'

export type FeishuAppConfig = {
  appId: string
  appSecret: string
  receiveId: string
  receiveIdType?: FeishuReceiveIdType
  baseUrl?: string
}

export type ImIOConfig = {
  feishu: FeishuAppConfig
  autoStartReceiver?: boolean
  requestTimeoutMs?: number
  onError?: (error: unknown, message?: StdoutMessage) => void
  logger?: (msg: string, meta?: Record<string, unknown>) => void
}

export type FeishuSendMessageRequest = {
  params: {
    receive_id_type: FeishuReceiveIdType
  }
  data: {
    receive_id: string
    msg_type: 'text' | 'interactive' | 'post'
    content: string
  }
}

export type FeishuSendMessageResponse = {
  message_id: string
}

export type FeishuMessageReceiveEvent = {
  sender?: {
    sender_type?: string
  }
  message?: {
    message_id?: string
    chat_id?: string
    message_type?: string
    content?: string
  }
}

const MAX_RECENT_INBOUND_MESSAGE_IDS = 1000
const FEISHU_COMPACT_TOOL_CALL_DISPLAY = true
const FEISHU_STREAM_ELEMENT_ID = 'assistant_stream'
const TOOL_CARD_META_ELEMENT_ID = 'tool_meta'
const TOOL_CARD_STATUS_ELEMENT_ID = 'tool_status'
const TOOL_CARD_INPUT_ELEMENT_ID = 'tool_input'
const TOOL_CARD_RESULT_ELEMENT_ID = 'tool_result'

type SDKAssistantMessage = Extract<StdoutMessage, { type: 'assistant' }>
type SDKStreamEventMessage = Extract<StdoutMessage, { type: 'stream_event' }>
type SDKResultMessage = Extract<StdoutMessage, { type: 'result' }>
type SDKSystemInitMessage = Extract<
  StdoutMessage,
  { type: 'system'; subtype: 'init' }
>
type SDKSystemStatusMessage = Extract<
  StdoutMessage,
  { type: 'system'; subtype: 'status' }
>
type SDKToolProgressMessage = Extract<StdoutMessage, { type: 'tool_progress' }>
type SDKUserOutputMessage = Extract<StdoutMessage, { type: 'user' }>
type SDKToolLifecycleSystemMessage = Extract<
  StdoutMessage,
  {
    type: 'system'
    subtype: 'task_started' | 'task_progress' | 'task_notification'
  }
>

type ActiveFeishuCard = {
  cardId: string
  messageId: string
  sequence: number
  streamedText: string
  blockIndex: number
  finalized: boolean
}

type ToolCardState = {
  isError: boolean
  toolUseId: string
  toolName: string
  blockIndex: number
  cardId: string
  messageId: string
  sequence: number
  inputJson: string
  resultText: string
  resultElementCreated: boolean
  finalized: boolean
  lastStatus: string
}

type CompactToolCardState = {
  cardId: string
  messageId: string
  sequence: number
  total: number
  completed: number
  failed: number
  finalizedToolUseIds: Set<string>
  toolUseIds: string[]
  closed: boolean
}

type PendingPlanApproval = {
  requestId: string
  toolUseId: string
  plan: string
  planFilePath: string
  description: string
}

export const larkClient = (config: ImIOConfig): Lark.Client =>
  new Lark.Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: config.feishu.baseUrl ?? Lark.Domain.Feishu,
  })

export const createLarkClient = larkClient

export const createLarkWsClient = (config: ImIOConfig): Lark.WSClient =>
  new Lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: config.feishu.baseUrl ?? Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
  })

export class ImIO extends StructuredIO {
  private readonly config: ImIOConfig
  private readonly inputStream: PassThrough
  private readonly useStdinEventInput: boolean
  private client: Lark.Client | null = null
  private wsClient: Lark.WSClient | null = null
  private stdinEventReader: ReadLineInterface | null = null
  private receiverStartPromise: Promise<void> | null = null
  private inputEnded = false
  private closed = false
  private readonly recentInboundMessageIds = new Set<string>()
  private readonly recentInboundMessageIdOrder: string[] = []
  private activeCard: ActiveFeishuCard | null = null
  private readonly streamTextByBlockIndex = new Map<number, string>()
  private readonly toolUseIdByBlockIndex = new Map<number, string>()
  private readonly toolCardsByToolUseId = new Map<string, ToolCardState>()
  private compactToolCard: CompactToolCardState | null = null
  private pendingPlanApproval: PendingPlanApproval | null = null

  constructor(
    input: AsyncIterable<string>,
    config: ImIOConfig,
    replayUserMessages?: boolean,
    inputFormat?: string | undefined,
  ) {
    const inputStream = new PassThrough({ encoding: 'utf8' })
    super(inputStream, replayUserMessages)
    this.config = config
    this.inputStream = inputStream
    this.useStdinEventInput = inputFormat === 'stream-json'

    registerCleanup(async () => this.close())
    if (!this.useStdinEventInput) {
      void this.forwardInitialPrompt(input)
    }

    if (config.autoStartReceiver !== false) {
      void this.startReceiver().catch(() => {})
    }
  }

  // override functions
  override async write(message: StdoutMessage): Promise<void> {
    if (this.closed) {
      this.log('write skipped because ImIO is closed', {
        messageType: message.type,
      })
      return
    }

    if (!this.shouldForward(message)) {
      this.log('write skipped by shouldForward', {
        messageType: message.type,
      })
      return
    }

    try {
      await this.ensureReady()
      if (await this.tryHandleCardMessage(message)) {
        return
      }

      const request = this.buildSendRequest(message)
      await this.sendFeishuMessage(request)
    } catch (error) {
      this.handleError(error, message)
      //throw error
    }
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    if (this.activeCard) {
      const card = this.activeCard
      this.activeCard = null
      void this.deleteStreamingCard(card).catch(error => {
        this.handleError(error)
      })
    }
    this.stdinEventReader?.close()
    this.wsClient?.close()
    this.endInput()
    this.log('ImIO closed')
  }

  // common utils
  protected handleError(error: unknown, message?: StdoutMessage): void {
    this.config.onError?.(error, message)
  }

  protected log(msg: string, meta?: Record<string, unknown>): void {
    this.config.logger?.(msg, meta)
  }

  private writeInputLine(line: string): void {
    if (this.closed || this.inputEnded) {
      return
    }
    this.inputStream.write(line)
  }

  private endInput(): void {
    if (this.inputEnded) {
      return
    }
    this.inputEnded = true
    this.inputStream.end()
  }

  // init
  private validateConfig(): void {
    const { appId, appSecret, receiveId } = this.config.feishu
    if (!appId) {
      throw new Error('ImIO requires feishu.appId')
    }
    if (!appSecret) {
      throw new Error('ImIO requires feishu.appSecret')
    }
    if (!receiveId) {
      throw new Error('ImIO requires feishu.receiveId')
    }
  }

  protected getLarkWsClient(): Lark.WSClient {
    if (this.wsClient === null) {
      this.wsClient = createLarkWsClient(this.config)
    }
    return this.wsClient
  }

  protected getLarkClient(): Lark.Client {
    if (this.client === null) {
      this.client = createLarkClient(this.config)
    }
    return this.client
  }

  async startReceiver(): Promise<void> {
    if (this.closed) {
      return
    }
    if (this.receiverStartPromise) {
      return this.receiverStartPromise
    }

    this.receiverStartPromise = this.startReceiverInternal().catch(error => {
      this.log('Feishu inbound source failed to start', {
        error: error instanceof Error ? error.message : String(error),
        source: this.useStdinEventInput ? 'stdin' : 'receiver',
      })
      this.handleError(error)
      this.endInput()
      throw error
    })

    return this.receiverStartPromise
  }

  private async startReceiverInternal(): Promise<void> {
    if (this.useStdinEventInput) {
      await this.startStdinEventReader()
      return
    }

    this.validateConfig()
    await this.getLarkWsClient().start({
      eventDispatcher: this.createEventDispatcher(),
    })
    this.log('Feishu receiver started')
  }

  protected createEventDispatcher(): Lark.EventDispatcher {
    return new Lark.EventDispatcher({
      loggerLevel: Lark.LoggerLevel.warn,
    }).register({
      'im.message.receive_v1': async (event: FeishuMessageReceiveEvent) => {
        await this.handleFeishuMessageEvent(event)
      },
    })
  }

  private async startStdinEventReader(): Promise<void> {
    process.stdin.setEncoding('utf8')
    const reader = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    })
    this.stdinEventReader = reader
    this.log('Feishu stdin event reader started')

    try {
      for await (const rawLine of reader) {
        if (this.closed) {
          return
        }

        const line = rawLine.trim()
        if (line === '') {
          continue
        }

        await this.handleFeishuMessageEvent(this.parseFeishuStdinEvent(line))
      }
    } finally {
      if (this.stdinEventReader === reader) {
        this.stdinEventReader = null
      }
      this.endInput()
      this.log('Feishu stdin event reader stopped')
    }
  }

  protected parseFeishuStdinEvent(line: string): FeishuMessageReceiveEvent {
    try {
      return JSON.parse(line) as FeishuMessageReceiveEvent
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to parse Feishu stdin event JSON: ${detail}`)
    }
  }

  private async forwardInitialPrompt(
    initialPrompt: AsyncIterable<string>,
  ): Promise<void> {
    try {
      for await (const chunk of initialPrompt) {
        if (this.closed) {
          return
        }
        this.writeInputLine(String(chunk).replace(/\n$/, '') + '\n')
      }
    } catch (error) {
      this.handleError(error)
      this.endInput()
    }
  }

  // send helper functions
  protected async ensureReady(): Promise<void> {
    this.validateConfig()
    this.getLarkClient()
  }

  protected shouldForward(_message: StdoutMessage): boolean {
    return true
  }

  protected isSdkAssistantMessage(
    message: StdoutMessage,
  ): message is SDKAssistantMessage {
    return message.type === 'assistant'
  }

  protected isSdkStreamEventMessage(
    message: StdoutMessage,
  ): message is SDKStreamEventMessage {
    return message.type === 'stream_event'
  }

  protected isSdkResultMessage(
    message: StdoutMessage,
  ): message is SDKResultMessage {
    return message.type === 'result'
  }

  protected isSdkSystemInitMessage(
    message: StdoutMessage,
  ): message is SDKSystemInitMessage {
    return message.type === 'system' && message.subtype === 'init'
  }

  protected isSdkSystemStatusMessage(
    message: StdoutMessage,
  ): message is SDKSystemStatusMessage {
    return message.type === 'system' && message.subtype === 'status'
  }

  protected isSdkToolProgressMessage(
    message: StdoutMessage,
  ): message is SDKToolProgressMessage {
    return message.type === 'tool_progress'
  }

  protected isSdkUserOutputMessage(
    message: StdoutMessage,
  ): message is SDKUserOutputMessage {
    return message.type === 'user'
  }

  protected isSdkControlRequestMessage(
    message: StdoutMessage,
  ): message is SDKControlRequest {
    return message.type === 'control_request'
  }

  protected isToolLifecycleSystemMessage(
    message: StdoutMessage,
  ): message is SDKToolLifecycleSystemMessage {
    return (
      message.type === 'system' &&
      (message.subtype === 'task_started' ||
        message.subtype === 'task_progress' ||
        message.subtype === 'task_notification')
    )
  }

  protected async tryHandleCardMessage(message: StdoutMessage): Promise<boolean> {
    if (this.isSdkSystemInitMessage(message)) {
      await this.handleSystemMessage(message)
      return true
    }

    if (this.isSdkSystemStatusMessage(message)) {
      await this.handleSystemStatusMessage(message)
      return true
    }

    if (this.isToolLifecycleSystemMessage(message)) {
      return this.handleToolLifecycleSystemMessage(message)
    }

    if (this.isSdkStreamEventMessage(message)) {
      await this.handleStreamingEvent(message)
      return true
    }

    if (this.isSdkAssistantMessage(message)) {
      await this.handleAssistantMessage(message)
      return true
    }

    if (this.isSdkToolProgressMessage(message)) {
      return this.handleToolProgressMessage(message)
    }

    if (this.isSdkUserOutputMessage(message)) {
      return this.handleToolResultUserMessage(message)
    }

    if (this.isSdkControlRequestMessage(message)) {
      return this.handleControlRequestMessage(message)
    }

    if (this.isSdkResultMessage(message)) {
      await this.handleResultMessage(message)
      return true
    }

    return false
  }

  protected buildSendRequest(message: StdoutMessage): FeishuSendMessageRequest {
    return this.buildTextSendRequest(this.buildFeishuText(message))
  }

  protected isExitPlanModeControlRequest(
    message: SDKControlRequest,
  ): message is SDKControlRequest & {
    request: {
      subtype: 'can_use_tool'
      request_id?: never
      tool_name: string
      tool_use_id: string
      input?: Record<string, unknown>
      description?: string
    }
  } {
    return (
      message.request.subtype === 'can_use_tool' &&
      message.request.tool_name === EXIT_PLAN_MODE_TOOL_NAME &&
      typeof message.request.tool_use_id === 'string'
    )
  }

  protected buildTextSendRequest(text: string): FeishuSendMessageRequest {
    return {
      params: {
        receive_id_type: this.config.feishu.receiveIdType ?? 'chat_id',
      },
      data: {
        receive_id: this.config.feishu.receiveId,
        msg_type: 'post',
        content: JSON.stringify({
          "zh_cn": {
            "title": undefined,
            "content": [
              [
                {
                  "tag": "md",
                  "text": text,
                }
              ]
            ]
          }
        }),
      },
    }
  }

  protected buildInteractiveCardRequest(cardId: string): FeishuSendMessageRequest {
    return {
      params: {
        receive_id_type: this.config.feishu.receiveIdType ?? 'chat_id',
      },
      data: {
        receive_id: this.config.feishu.receiveId,
        msg_type: 'interactive',
        content: JSON.stringify({
          type: 'card',
          data: {
            card_id: cardId,
          },
        }),
      },
    }
  }

  protected buildFeishuText(message: StdoutMessage): string {
    const subtype =
      'subtype' in message && typeof message.subtype === 'string'
        ? `/${message.subtype}`
        : ''
    return `[${message.type}${subtype}] ${this.serializeMessage(message)}`
  }

  protected serializeMessage(message: StdoutMessage): string {
    return JSON.stringify(message, null, 2)
  }

  protected async createCardEntity(card: Record<string, unknown>): Promise<string> {
    const createResponse = await this.getLarkClient().cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(card),
      },
    })
    const cardId = createResponse?.data?.card_id
    if (!cardId) {
      throw new Error(
        `Feishu card create failed: ${createResponse?.msg ?? 'missing card_id'}`,
      )
    }
    return cardId
  }

  protected async sendCard(
    card: Record<string, unknown>,
  ): Promise<{ cardId: string; messageId: string }> {
    const cardId = await this.createCardEntity(card)
    const sendResponse = await this.sendFeishuMessage(
      this.buildInteractiveCardRequest(cardId),
    )
    return {
      cardId,
      messageId: sendResponse.message_id,
    }
  }

  protected nextCardSequence(card: { sequence: number }): number {
    const next = card.sequence
    card.sequence += 1
    return next
  }

  protected truncateCardText(value: string, max = 12000): string {
    if (value.length <= max) {
      return value
    }
    return `${value.slice(0, max)}\n... (truncated)`
  }

  protected escapeCodeFenceContent(value: string): string {
    return value.replace(/```/g, '\\`\\`\\`')
  }

  protected formatJsonPreview(raw: string): string {
    const trimmed = raw.trim()
    if (trimmed === '') {
      return ''
    }

    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return raw
    }
  }

  protected buildCodeBlockMarkdown(
    title: string,
    body: string,
    language = '',
  ): string {
    if (body.trim() === '') {
      return `**${title}**\n_Empty_`
    }

    const rendered = this.escapeCodeFenceContent(this.truncateCardText(body))
    return `**${title}**\n\`\`\`${language}\n${rendered}\n\`\`\``
  }
  
  protected async updateCardElement(
    cardId: string,
    elementId: string,
    newElement: unknown,
    sequence: number,
  ): Promise<void> {
    await this.getLarkClient().cardkit.v1.cardElement.update({
      path: {
        card_id: cardId,
        element_id: elementId,
      },
      data: {
        element: JSON.stringify(newElement),
        sequence,
        uuid: randomUUID(),
      },
    })
  }
  
  protected async updateCardFull(
    cardId: string,
    card: unknown,
    sequence: number,
  ): Promise<void> {
    await this.getLarkClient().cardkit.v1.card.update({
      path: {
        card_id: cardId,
      },
      data: {
        card: {
          type: "card_json",
          data: JSON.stringify(card),
        },
        sequence,
        uuid: randomUUID(),
      },
    })
  }

  protected async updateCardStreamElementContent(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    await this.getLarkClient().cardkit.v1.cardElement.content({
      path: {
        card_id: cardId,
        element_id: elementId,
      },
      data: {
        content,
        sequence,
        uuid: randomUUID(),
      },
    })
  }

  // send message
  protected async handleStreamingEvent(
    message: SDKStreamEventMessage,
  ): Promise<void> {
    const event = message.event
    if (!event || typeof event !== 'object' || !('type' in event)) {
      return
    }

    switch (event.type) {
      case 'message_start':
        await this.resetStreamingState()
        return
      case 'message_stop':
        this.streamTextByBlockIndex.clear()
        return
      case 'content_block_start': {
        const textBlockIndex = this.getTextBlockIndexFromStart(event)
        if (textBlockIndex !== null) {
          this.streamTextByBlockIndex.set(textBlockIndex, '')
          await this.startStreamingCard(textBlockIndex)
          return
        }

        const toolStart = this.extractToolUseStart(event)
        if (toolStart) {
          await this.startToolCard(
            toolStart.blockIndex,
            toolStart.toolUseId,
            toolStart.toolName,
          )
        }
        return
      }
      case 'content_block_delta': {
        const textDelta = this.extractTextDelta(event)
        if (textDelta) {
          const current = this.streamTextByBlockIndex.get(textDelta.blockIndex) ?? ''
          const next = current + textDelta.text
          this.streamTextByBlockIndex.set(textDelta.blockIndex, next)
          await this.updateStreamingCard(textDelta.blockIndex, next)
          return
        }

        const toolDelta = this.extractToolInputDelta(event)
        if (toolDelta) {
          await this.updateToolCardInput(toolDelta.blockIndex, toolDelta.partialJson)
        }
        return
      }
      case 'content_block_stop': {
        const blockIndex = this.getStreamBlockIndex(event)
        if (blockIndex === null) {
          return
        }

        const toolUseId = this.toolUseIdByBlockIndex.get(blockIndex)
        if (toolUseId) {
          this.toolUseIdByBlockIndex.delete(blockIndex)
          await this.updateToolCardStatus(toolUseId, '_Running..._')
        }

        await this.finalizeStreamingCard()
        return
      }
      default:
        return
    }
  }

  protected getStreamBlockIndex(event: unknown): number | null {
    if (
      !event ||
      typeof event !== 'object' ||
      !('index' in event) ||
      typeof event.index !== 'number'
    ) {
      return null
    }

    return event.index
  }

  protected getTextBlockIndexFromStart(event: unknown): number | null {
    const blockIndex = this.getStreamBlockIndex(event)
    if (
      blockIndex === null ||
      !event ||
      typeof event !== 'object' ||
      !('content_block' in event) ||
      !event.content_block ||
      typeof event.content_block !== 'object' ||
      !('type' in event.content_block)
    ) {
      return null
    }

    if (event.content_block.type !== 'text') {
      return null
    }

    return blockIndex
  }

  protected extractToolUseStart(
    event: unknown,
  ): { blockIndex: number; toolUseId: string; toolName: string } | null {
    const blockIndex = this.getStreamBlockIndex(event)
    if (
      blockIndex === null ||
      !event ||
      typeof event !== 'object' ||
      !('content_block' in event) ||
      !event.content_block ||
      typeof event.content_block !== 'object' ||
      !('type' in event.content_block)
    ) {
      return null
    }

    const contentBlock = event.content_block as {
      type?: unknown
      id?: unknown
      name?: unknown
    }

    if (
      contentBlock.type !== 'tool_use' &&
      contentBlock.type !== 'server_tool_use'
    ) {
      return null
    }

    if (
      typeof contentBlock.id !== 'string' ||
      typeof contentBlock.name !== 'string'
    ) {
      return null
    }

    return {
      blockIndex,
      toolUseId: contentBlock.id,
      toolName: contentBlock.name,
    }
  }

  protected extractTextDelta(
    event: unknown,
  ): { blockIndex: number; text: string } | null {
    const blockIndex = this.getStreamBlockIndex(event)
    if (
      blockIndex === null ||
      !event ||
      typeof event !== 'object' ||
      !('delta' in event) ||
      !event.delta ||
      typeof event.delta !== 'object' ||
      !('type' in event.delta) ||
      event.delta.type !== 'text_delta' ||
      !('text' in event.delta) ||
      typeof event.delta.text !== 'string'
    ) {
      return null
    }

    return {
      blockIndex,
      text: event.delta.text,
    }
  }

  protected extractToolInputDelta(
    event: unknown,
  ): { blockIndex: number; partialJson: string } | null {
    const blockIndex = this.getStreamBlockIndex(event)
    if (
      blockIndex === null ||
      !event ||
      typeof event !== 'object' ||
      !('delta' in event) ||
      !event.delta ||
      typeof event.delta !== 'object' ||
      !('type' in event.delta) ||
      event.delta.type !== 'input_json_delta' ||
      !('partial_json' in event.delta) ||
      typeof event.delta.partial_json !== 'string'
    ) {
      return null
    }

    return {
      blockIndex,
      partialJson: event.delta.partial_json,
    }
  }

  protected async resetStreamingState(): Promise<void> {
    if (this.activeCard) {
      const card = this.activeCard
      this.activeCard = null
      await this.deleteStreamingCard(card)
    }
    this.streamTextByBlockIndex.clear()
  }

  protected async startStreamingCard(blockIndex: number): Promise<void> {
    if (this.activeCard) {
      const card = this.activeCard
      this.activeCard = null
      await this.deleteStreamingCard(card)
    }

    const { cardId, messageId } = await this.sendCard(this.buildStreamingCard())

    this.activeCard = {
      cardId,
      messageId,
      sequence: 1,
      streamedText: '',
      blockIndex,
      finalized: false,
    }

    this.log('Feishu streaming card created', {
      cardId,
      messageId,
      blockIndex,
    })
  }

  protected buildStreamingCard(): Record<string, unknown> {
    return {
      schema: '2.0',
      header: {
        title: {
          tag: 'plain_text',
          content: 'Claude Code',
        },
      },
      config: {
        streaming_mode: true,
        summary: {
          content: '',
        },
        streaming_config: {
          print_frequency_ms: {
            default: 70,
            android: 70,
            ios: 70,
            pc: 70,
          },
          print_step: {
            default: 1,
            android: 1,
            ios: 1,
            pc: 1,
          },
          print_strategy: 'fast',
        },
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: '_Generating..._',
            element_id: FEISHU_STREAM_ELEMENT_ID,
          },
        ],
      },
    }
  }

  protected async updateStreamingCard(
    blockIndex: number,
    content: string,
  ): Promise<boolean> {
    if (!this.activeCard || this.activeCard.blockIndex !== blockIndex) {
      return false
    }

    if (content === this.activeCard.streamedText) {
      return true
    }

    await this.updateCardStreamElementContent(
      this.activeCard.cardId,
      FEISHU_STREAM_ELEMENT_ID,
      content,
      this.nextCardSequence(this.activeCard),
    )

    this.activeCard.streamedText = content
    return true
  }

  protected async finalizeStreamingCard(): Promise<void> {
    if (!this.activeCard || this.activeCard.finalized) {
      return
    }

    this.activeCard.finalized = true
  }

  protected buildToolCard(
    toolName: string,
    toolUseId: string,
  ): Record<string, unknown> {
    return {
      schema: '2.0',
      header: {
        title: {
          tag: 'plain_text',
          content: `Tool: ${toolName}`,
        },
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: this.buildToolMetaMarkdown(toolName, toolUseId),
            element_id: TOOL_CARD_META_ELEMENT_ID,
          },
          {
            tag: 'markdown',
            content: this.buildToolStatusMarkdown('_Preparing input..._'),
            element_id: TOOL_CARD_STATUS_ELEMENT_ID,
          },
          {
            tag: 'markdown',
            content: this.buildCodeBlockMarkdown('Input', '{}', 'json'),
            element_id: TOOL_CARD_INPUT_ELEMENT_ID,
          },
        ],
      },
    }
  }

  protected buildToolCardComplete(
    state: ToolCardState
  ): Record<string, unknown> {
    return {
      schema: '2.0',
      body: {
        elements: [
          {
            "tag": "collapsible_panel",
            "element_id": "custom_id", 
            "direction": "vertical",
            "vertical_spacing": "8px",
            "horizontal_spacing": "8px",
            "padding": "8px 8px 8px 8px",
            "expanded": false,
            "header": {
              title: {
                tag: 'plain_text',
                content: `Tool: ${state.toolName}`,
              },
              "background_color": "grey",
              "vertical_align": "center",
              "padding": "4px 0px 4px 8px",
              "position": "top",
              "icon": {
                "tag": "standard_icon",
                "token": "setting-inter_outlined",
                "color": "black",
                "size": "16px 16px"
              },
              "icon_position": "left",
            },
            "elements": [
              {
                tag: 'markdown',
                content: this.buildToolMetaMarkdown(state.toolName, state.toolUseId),
                element_id: TOOL_CARD_META_ELEMENT_ID,
              },
              {
                tag: 'markdown',
                content: this.buildToolStatusMarkdown(state.lastStatus),
                element_id: TOOL_CARD_STATUS_ELEMENT_ID,
              },
              {
                tag: 'markdown',
                content: this.buildCodeBlockMarkdown('Input', state.inputJson, 'json'),
                element_id: TOOL_CARD_INPUT_ELEMENT_ID,
              },
              {
                tag: 'markdown',
                content: this.buildCodeBlockMarkdown(
                  state.isError ? 'Result (Error)' : 'Result',
                  state.resultText,
                ),
                element_id: TOOL_CARD_RESULT_ELEMENT_ID,
              },
            ]
          }
        ],
      },
    }
  }

  protected buildToolMetaMarkdown(toolName: string, toolUseId: string): string {
    return [
      `**Tool**: \`${this.escapeMarkdownInlineCode(toolName)}\``,
      `**Tool Use ID**: \`${this.escapeMarkdownInlineCode(toolUseId)}\``,
    ].join('\n')
  }

  protected buildToolStatusMarkdown(status: string): string {
    return `**Status**: ${this.truncateCardText(status, 2000)}`
  }

  protected buildPlanApprovalMarkdown(approval: PendingPlanApproval): string {
    const lines = ['**计划审核**', approval.description || '请审核当前计划。']

    if (approval.planFilePath !== '') {
      lines.push(`**Plan File**: \`${this.escapeMarkdownInlineCode(approval.planFilePath)}\``)
    }

    if (approval.plan !== '') {
      lines.push(this.buildCodeBlockMarkdown('Plan', approval.plan))
    }

    lines.push('回复 `/allow` 批准，回复 `/deny` 拒绝。')
    return lines.join('\n\n')
  }

  protected buildStatusChangeCard(
    message: SDKSystemStatusMessage,
  ): Record<string, unknown> {
    return {
      schema: '2.0',
      header: {
        title: {
          tag: 'plain_text',
          content: '状态变化',
        },
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: this.buildStatusChangeMarkdown(message),
          },
        ],
      },
    }
  }

  protected buildStatusChangeMarkdown(message: SDKSystemStatusMessage): string {
    const lines = ['**检测到状态变化**']

    if (message.permissionMode) {
      lines.push(
        `**Permission Mode**: \`${this.escapeMarkdownInlineCode(message.permissionMode)}\``,
      )
    }

    lines.push(
      `**Status**: ${message.status === null ? '`null`' : `\`${this.escapeMarkdownInlineCode(message.status)}\``}`,
    )

    return lines.join('\n')
  }

  protected buildCompactToolCard(state: CompactToolCardState): Record<string, unknown> {
    const curTools = state.toolUseIds.map(id => this.toolCardsByToolUseId.get(id)!)
    const pendingTools = curTools.filter(tool => !tool.finalized)
    const completedTools = curTools.filter(tool => tool.finalized)
    const visibleCompletedTools =
      pendingTools.length >= 2 ? [] : completedTools.slice(-(2 - pendingTools.length))
    const visibleTools = [...visibleCompletedTools, ...pendingTools]
    const hiddenCompletedCount = completedTools.length - visibleCompletedTools.length
    const lines: string[] = []

    if (hiddenCompletedCount > 0) {
      lines.push(`…（${hiddenCompletedCount}个工具调用，${hiddenCompletedCount}个已完成）`)
    }

    visibleTools.forEach(tool => {
      lines.push(`- ${this.escapeMarkdownInlineCode(tool.toolName)} ${tool.lastStatus}`)
    })

    if (state.closed && lines.length === 0) {
      lines.push('_No tool calls_')
    }

    return {
      schema: '2.0',
      header: {
        title: {
          tag: 'plain_text',
          content: 'Tool Calls',
        },
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: lines.join('\n'),
          },
        ],
      },
    }
  }

  protected async ensureCompactToolCard(): Promise<CompactToolCardState> {
    if (this.compactToolCard) {
      return this.compactToolCard
    }

    const { cardId, messageId } = await this.sendCard(
      this.buildCompactToolCard({
        cardId: '',
        messageId: '',
        sequence: 0,
        total: 0,
        completed: 0,
        failed: 0,
        finalizedToolUseIds: new Set<string>(),
        toolUseIds: [],
        closed: false,
      }),
    )

    this.compactToolCard = {
      cardId,
      messageId,
      sequence: 1,
      total: 0,
      completed: 0,
      failed: 0,
      finalizedToolUseIds: new Set<string>(),
      toolUseIds: [],
      closed: false,
    }

    return this.compactToolCard
  }

  protected async ensureOpenCompactToolCard(): Promise<CompactToolCardState> {
    const state = await this.ensureCompactToolCard()
    if (!state.closed) {
      return state
    }

    this.compactToolCard = null
    return this.ensureCompactToolCard()
  }

  protected async closeCompactToolCard(): Promise<void> {
    const state = this.compactToolCard
    if (!state || state.closed) {
      return
    }

    state.closed = true
    await this.refreshCompactToolCard()
    this.compactToolCard = null
  }

  protected async refreshCompactToolCard(): Promise<void> {
    const state = this.compactToolCard
    if (!state) {
      return
    }

    await this.updateCardFull(
      state.cardId,
      this.buildCompactToolCard(state),
      this.nextCardSequence(state),
    )
  }

  protected async startToolCard(
    blockIndex: number,
    toolUseId: string,
    toolName: string,
  ): Promise<void> {
    if (FEISHU_COMPACT_TOOL_CALL_DISPLAY) {
      this.toolUseIdByBlockIndex.set(blockIndex, toolUseId)
      const state = await this.ensureOpenCompactToolCard()
      if (!state.toolUseIds.includes(toolUseId)) {
        state.total = state.toolUseIds.length
        state.toolUseIds.push(toolUseId)
        this.toolCardsByToolUseId.set(toolUseId, {
          isError: false,
          toolUseId,
          toolName,
          blockIndex,
          cardId: state.cardId,
          messageId: state.messageId,
          sequence: state.sequence,
          inputJson: '',
          resultText: '',
          resultElementCreated: false,
          finalized: false,
          lastStatus: '_Preparing input..._',
        })
        await this.refreshCompactToolCard()
      }
      return
    }

    if (this.toolCardsByToolUseId.has(toolUseId)) {
      this.toolUseIdByBlockIndex.set(blockIndex, toolUseId)
      return
    }

    const { cardId, messageId } = await this.sendCard(
      this.buildToolCard(toolName, toolUseId),
    )

    this.toolUseIdByBlockIndex.set(blockIndex, toolUseId)
    this.toolCardsByToolUseId.set(toolUseId, {
      isError: false,
      toolUseId,
      toolName,
      blockIndex,
      cardId,
      messageId,
      sequence: 1,
      inputJson: '',
      resultText: '',
      resultElementCreated: false,
      finalized: false,
      lastStatus: '_Preparing input..._',
    })

    this.log('Feishu tool card created', {
      toolUseId,
      toolName,
      cardId,
      messageId,
      blockIndex,
    })
  }

  protected async updateToolCardStatus(
    toolUseId: string,
    status: string,
  ): Promise<boolean> {
    const state = this.toolCardsByToolUseId.get(toolUseId)
    if (!state || state.lastStatus === status) {
      return Boolean(state)
    }

    state.lastStatus = status
    if (FEISHU_COMPACT_TOOL_CALL_DISPLAY) {
      await this.refreshCompactToolCard()
      return true
    }

    await this.updateCardElement(
      state.cardId,
      TOOL_CARD_STATUS_ELEMENT_ID,
      {
        tag: 'markdown',
        content: this.buildToolStatusMarkdown(status),
        element_id: TOOL_CARD_STATUS_ELEMENT_ID,
      },
      this.nextCardSequence(state),
    )
    return true
  }

  protected async updateToolCardInput(
    blockIndex: number,
    partialJson: string,
  ): Promise<boolean> {
    const toolUseId = this.toolUseIdByBlockIndex.get(blockIndex)
    if (!toolUseId) {
      return false
    }

    const state = this.toolCardsByToolUseId.get(toolUseId)
    if (!state) {
      return false
    }

    state.inputJson += partialJson

    if (state.lastStatus != "_Receiving input..._") {
      await this.updateToolCardStatus(toolUseId, '_Receiving input..._')
    }

    if (FEISHU_COMPACT_TOOL_CALL_DISPLAY) {
      return true
    }
    else {
      await this.updateCardElement(
        state.cardId,
        TOOL_CARD_INPUT_ELEMENT_ID,
        {
          tag: 'markdown',
          content: this.buildCodeBlockMarkdown(
                    'Input',
                    this.formatJsonPreview(state.inputJson) || '{}',
                    'json',
                  ),
          element_id: TOOL_CARD_INPUT_ELEMENT_ID,
        },
        this.nextCardSequence(state),
      )
      return true
    }
  }

  protected async handleToolProgressMessage(
    message: SDKToolProgressMessage,
  ): Promise<boolean> {
    const seconds = Number.isFinite(message.elapsed_time_seconds)
      ? message.elapsed_time_seconds.toFixed(1)
      : '0.0'
    return this.updateToolCardStatus(
      message.tool_use_id,
      `_Running..._ ${seconds}s`,
    )
  }

  protected async handleToolLifecycleSystemMessage(
    message: SDKToolLifecycleSystemMessage,
  ): Promise<boolean> {
    if (!message.tool_use_id) {
      return false
    }

    switch (message.subtype) {
      case 'task_started':
        return this.updateToolCardStatus(
          message.tool_use_id,
          `Task started: ${message.description}`,
        )
      case 'task_progress': {
        const details = [
          message.description,
          message.summary,
          message.last_tool_name ? `last tool: ${message.last_tool_name}` : '',
        ]
          .filter(Boolean)
          .join(' | ')
        return this.updateToolCardStatus(
          message.tool_use_id,
          details === '' ? '_Running..._' : details,
        )
      }
      case 'task_notification':
        return this.updateToolCardStatus(
          message.tool_use_id,
          `Task ${message.status}: ${message.summary}`,
        )
      default:
        return false
    }
  }

  protected isToolResultContentBlock(
    block: unknown,
  ): block is {
    type: 'tool_result'
    tool_use_id: string
    content?: unknown
    is_error?: boolean
  } {
    const candidate = block as {
      type?: unknown
      tool_use_id?: unknown
    } | null
    return (
      !!candidate &&
      typeof candidate === 'object' &&
      candidate.type === 'tool_result' &&
      typeof candidate.tool_use_id === 'string'
    )
  }

  protected extractToolResultBlocks(
    message: SDKUserOutputMessage,
  ): Array<{
    toolUseId: string
    resultText: string
    isError: boolean
  }> {
    const content = message.message?.content
    if (!Array.isArray(content)) {
      return []
    }

    return content
      .filter(block => this.isToolResultContentBlock(block))
      .map(block => ({
        toolUseId: block.tool_use_id,
        resultText: this.extractToolResultText(block, message.tool_use_result),
        isError: block.is_error === true,
      }))
  }

  protected extractToolResultText(
    block: { content?: unknown },
    structuredResult: unknown,
  ): string {
    if (typeof block.content === 'string' && block.content.trim() !== '') {
      return block.content
    }

    if (Array.isArray(block.content)) {
      return JSON.stringify(block.content, null, 2)
    }

    if (typeof structuredResult === 'string' && structuredResult.trim() !== '') {
      return structuredResult
    }

    if (structuredResult !== undefined) {
      return JSON.stringify(structuredResult, null, 2)
    }

    return '[tool_result]'
  }

  protected async appendToolResultElement(
    state: ToolCardState,
    content: string,
  ): Promise<void> {
    await this.getLarkClient().cardkit.v1.cardElement.create({
      path: {
        card_id: state.cardId,
      },
      data: {
        type: 'append',
        sequence: this.nextCardSequence(state),
        uuid: randomUUID(),
        elements: JSON.stringify([
          {
            tag: 'markdown',
            element_id: TOOL_CARD_RESULT_ELEMENT_ID,
            content,
          },
        ]),
      },
    })
  }

  protected async handleControlRequestMessage(
    message: SDKControlRequest,
  ): Promise<boolean> {
    if (!this.isExitPlanModeControlRequest(message)) {
      return false
    }

    const input = message.request.input ?? {}
    this.pendingPlanApproval = {
      requestId: message.request_id,
      toolUseId: message.request.tool_use_id,
      plan:
        typeof input.plan === 'string' ? this.truncateCardText(input.plan, 8000) : '',
      planFilePath:
        typeof input.planFilePath === 'string' ? input.planFilePath : '',
      description:
        typeof message.request.description === 'string'
          ? message.request.description
          : 'OpenClaude 请求退出 plan mode，请审核计划。',
    }

    await this.sendFeishuMessage(
      this.buildTextSendRequest(
        this.buildPlanApprovalMarkdown(this.pendingPlanApproval),
      ),
    )
    return true
  }

  protected async updateToolResultCard(
    toolUseId: string,
    resultText: string,
    isError: boolean,
  ): Promise<boolean> {
    const state = this.toolCardsByToolUseId.get(toolUseId)

    if (!state) {
      return false
    }

    state.isError = isError
    state.lastStatus = isError ? '_Failed_' : '_Completed_'
    state.resultElementCreated = true
    state.resultText = resultText
    state.finalized = true

    if (FEISHU_COMPACT_TOOL_CALL_DISPLAY) {
      await this.refreshCompactToolCard()
      return true
    }
    else {
      await this.updateCardFull(
        state.cardId,
        this.buildToolCardComplete(state),
        this.nextCardSequence(state),
      )
      return true
    }
  }

  protected async handleToolResultUserMessage(
    message: SDKUserOutputMessage,
  ): Promise<boolean> {
    const toolResults = this.extractToolResultBlocks(message)
    if (toolResults.length === 0) {
      return true
    }

    let handled = false
    for (const toolResult of toolResults) {
      const updated = await this.updateToolResultCard(
        toolResult.toolUseId,
        toolResult.resultText,
        toolResult.isError,
      )
      handled = updated || handled
    }

    return true//handled
  }

  protected async finalizeToolCard(state: ToolCardState): Promise<void> {
    if (state.finalized) {
      return
    }

    await this.updateToolCardStatus(state.toolUseId, '_Turn finished_')
    state.finalized = true
  }

  protected async handleAssistantMessage(message: SDKAssistantMessage): Promise<void> {
    const texts = this.extractAssistantTexts(message)
    if (this.activeCard) {
      const card = this.activeCard
      this.activeCard = null
      await this.deleteStreamingCard(card)
    }
    if (!this.hasToolUseContent(message) && texts.length > 0 && FEISHU_COMPACT_TOOL_CALL_DISPLAY) {
      await this.closeCompactToolCard()
    }

    for (const text of texts) {
      await this.sendFeishuMessage(this.buildTextSendRequest(text))
    }
  }

  protected extractAssistantTexts(message: SDKAssistantMessage): string[] {
    const content = message.message?.content
    if (!Array.isArray(content)) {
      return []
    }

    return content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          !!block &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'text' &&
          'text' in block &&
          typeof block.text === 'string' &&
          block.text.trim() !== '',
      )
      .map(block => block.text)
  }

  protected hasToolUseContent(message: SDKAssistantMessage): boolean {
    const content = message.message?.content
    if (!Array.isArray(content)) {
      return false
    }

    return content
      .some(
        (block): block is { type: 'tool_use' } =>
          !!block &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'tool_use',
      )
  }

  protected async handleResultMessage(message: SDKResultMessage): Promise<void> {
    this.toolUseIdByBlockIndex.clear()

    for (const state of this.toolCardsByToolUseId.values()) {
      await this.finalizeToolCard(state)
    }
    if (FEISHU_COMPACT_TOOL_CALL_DISPLAY) {
      await this.closeCompactToolCard()
    }
    this.pendingPlanApproval = null
    this.toolCardsByToolUseId.clear()
  }

  protected extractResultText(message: SDKResultMessage): string {
    if ('result' in message && typeof message.result === 'string') {
      return message.result
    }

    if ('errors' in message && Array.isArray(message.errors)) {
      const errors = message.errors.filter(
        error => typeof error === 'string' && error !== '',
      )
      if (errors.length > 0) {
        return errors.join('\n')
      }
    }

    const subtype =
      'subtype' in message && typeof message.subtype === 'string'
        ? message.subtype
        : 'result'
    return `[result/${subtype}]`
  }

  protected async deleteStreamingCard(card: ActiveFeishuCard): Promise<void> {
    try {
      await this.getLarkClient().cardkit.v1.card.settings({
        path: {
          card_id: card.cardId,
        },
        data: {
          settings: JSON.stringify({
            config: {
              streaming_mode: false,
            },
          }),
          sequence: card.sequence++,
          uuid: randomUUID(),
        },
      })
    } finally {
      await this.getLarkClient().im.message.delete({
        path: {
          message_id: card.messageId,
        },
      })
    }
  }

  protected async handleSystemMessage(
    message: SDKSystemInitMessage,
  ): Promise<void> {
    const card = {
      schema: '2.0',
      body: {
        elements: [
          {
            "tag": "collapsible_panel",
            "element_id": "custom_id",
            "direction": "vertical",
            "vertical_spacing": "8px",
            "horizontal_spacing": "8px",
            "padding": "8px 8px 8px 8px",
            "expanded": false,
            "header": {
              "title": {
                "tag": "plain_text",
                "content": "OpenClaude Session"
              },
              "background_color": "grey",
              "vertical_align": "center",
              "padding": "4px 0px 4px 8px",
              "position": "top",
              "icon": {
                "tag": "standard_icon",
                "token": "robot_outlined",
                "color": "black",
                "size": "16px 16px"
              },
              "icon_position": "left",
            },
            "elements": [
              {
                "tag": "markdown",
                "content": this.buildSystemMarkdown(message),
              }
            ]
          }
        ],
      },
    }

    const { cardId, messageId } = await this.sendCard(card)

    this.log('Feishu system card created', {
      cardId,
      messageId,
    })
  }

  protected async handleSystemStatusMessage(
    message: SDKSystemStatusMessage,
  ): Promise<void> {
    const { cardId, messageId } = await this.sendCard(
      this.buildStatusChangeCard(message),
    )

    this.log('Feishu system status card created', {
      cardId,
      messageId,
      status: message.status,
      permissionMode: message.permissionMode,
    })
  }

  protected buildSystemMarkdown(message: SDKSystemInitMessage): string {
    const lines = [
      '### Session Info',
      `- Model: \`${this.escapeMarkdownInlineCode(message.model)}\``,
      `- Working dir: \`${this.escapeMarkdownInlineCode(message.cwd)}\``,
      `- Permission: \`${this.escapeMarkdownInlineCode(message.permissionMode)}\``,
      `- Claude Code: \`${this.escapeMarkdownInlineCode(message.claude_code_version)}\``,
    ]

    if (Array.isArray(message.mcp_servers) && message.mcp_servers.length > 0) {
      const servers = message.mcp_servers
        .map(server => `${server.name}(${server.status})`)
        .join(', ')
      lines.push(`- MCP: ${servers}`)
    }

    return lines.join('\n')
  }

  protected escapeMarkdownInlineCode(value: unknown): string {
    return String(value ?? '').replace(/`/g, '\\`')
  }
  
  protected async sendFeishuMessage(
    request: FeishuSendMessageRequest,
  ): Promise<FeishuSendMessageResponse> {
    this.log('sending feishu message through Lark client', {
      receiveId: request.data.receive_id,
      receiveIdType: request.params.receive_id_type,
      msgType: request.data.msg_type,
    })

    const response = await this.getLarkClient().im.message.create(request)
    const messageId = response?.data?.message_id
    if (!messageId) {
      throw new Error(
        `Feishu message send failed: ${response?.msg ?? 'missing message_id'}`,
      )
    }

    return {
      message_id: messageId,
    }
  }

  // receive message
  protected async handleFeishuMessageEvent(
    event: FeishuMessageReceiveEvent,
  ): Promise<void> {
    if (!this.shouldAcceptInboundEvent(event)) {
      return
    }

    const prompt = this.extractUserPromptFromEvent(event)
    if (!prompt) {
      return
    }

    if (this.tryHandlePlanApprovalCommand(prompt.trim())) {
      return
    }

    this.enqueueUserMessage(prompt)
  }

  protected shouldAcceptInboundEvent(event: FeishuMessageReceiveEvent): boolean {
    if (this.closed) {
      return false
    }

    if (event.sender?.sender_type !== 'user') {
      return false
    }

    const messageId = event.message?.message_id
    if (!messageId || this.isDuplicateInboundMessage(messageId)) {
      return false
    }

    if (event.message?.message_type !== 'text') {
      this.log('Ignoring non-text Feishu inbound message', {
        messageId,
        messageType: event.message?.message_type,
      })
      return false
    }

    if (
      (this.config.feishu.receiveIdType ?? 'chat_id') === 'chat_id' &&
      event.message?.chat_id !== this.config.feishu.receiveId
    ) {
      this.log('Ignoring Feishu inbound message for a different chat', {
        messageId,
        chatId: event.message?.chat_id,
      })
      return false
    }

    return true
  }

  protected extractUserPromptFromEvent(
    event: FeishuMessageReceiveEvent,
  ): string | null {
    const rawContent = event.message?.content?.trim()
    if (!rawContent) {
      return null
    }

    try {
      const parsed = JSON.parse(rawContent) as { text?: unknown }
      if (typeof parsed.text === 'string' && parsed.text.trim() !== '') {
        return parsed.text
      }
    } catch {
      // Fall back to the raw payload so plaintext-compatible payloads still work.
    }

    return rawContent
  }

  protected tryHandlePlanApprovalCommand(content: string): boolean {
    if (!this.pendingPlanApproval) {
      return false
    }

    const behavior =
      content === '/allow' ? 'allow' : content === '/deny' ? 'deny' : null
    if (!behavior) {
      return false
    }

    const approval = this.pendingPlanApproval
    this.pendingPlanApproval = null
    this.writeInputLine(
      jsonStringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: approval.requestId,
          response:
            behavior === 'allow'
              ? {
                  behavior: 'allow',
                  updatedInput: {},
                  toolUseID: approval.toolUseId,
                }
              : {
                  behavior: 'deny',
                  message: 'Denied by user',
                  toolUseID: approval.toolUseId,
                },
        },
      }) + '\n',
    )
    void this
      .sendFeishuMessage(
        this.buildTextSendRequest(
          behavior === 'allow' ? '已批准计划审核。' : '已拒绝计划审核。',
        ),
      )
      .catch(error => {
        this.handleError(error)
      })
    return true
  }

  protected enqueueUserMessage(content: string): void {
    if (this.closed) {
      return
    }

    this.writeInputLine(
      jsonStringify(this.buildSdkUserMessage(content.trim())) + '\n',
    )
  }

  protected buildSdkUserMessage(content: string): SDKUserMessage {
    return {
      type: 'user',
      session_id: '',
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
    }
  }

  // receive: dup check
  private isDuplicateInboundMessage(messageId: string): boolean {
    if (this.recentInboundMessageIds.has(messageId)) {
      return true
    }

    this.recentInboundMessageIds.add(messageId)
    this.recentInboundMessageIdOrder.push(messageId)

    if (this.recentInboundMessageIdOrder.length > MAX_RECENT_INBOUND_MESSAGE_IDS) {
      const oldest = this.recentInboundMessageIdOrder.shift()
      if (oldest) {
        this.recentInboundMessageIds.delete(oldest)
      }
    }

    return false
  }
}
