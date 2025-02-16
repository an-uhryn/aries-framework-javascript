import type { DependencyManager } from '../../plugins'
import type { Key } from '../dids'
import type { OutOfBandRecord } from '../oob/repository'
import type { ConnectionType } from './models'
import type { ConnectionRecord } from './repository/ConnectionRecord'
import type { Routing } from './services'

import { AgentConfig } from '../../agent/AgentConfig'
import { Dispatcher } from '../../agent/Dispatcher'
import { MessageSender } from '../../agent/MessageSender'
import { createOutboundMessage } from '../../agent/helpers'
import { ReturnRouteTypes } from '../../decorators/transport/TransportDecorator'
import { AriesFrameworkError } from '../../error'
import { injectable, module } from '../../plugins'
import { DidResolverService } from '../dids'
import { DidRepository } from '../dids/repository'
import { OutOfBandService } from '../oob/OutOfBandService'
import { RoutingService } from '../routing/services/RoutingService'

import { DidExchangeProtocol } from './DidExchangeProtocol'
import {
  ConnectionRequestHandler,
  ConnectionResponseHandler,
  AckMessageHandler,
  TrustPingMessageHandler,
  TrustPingResponseMessageHandler,
  DidExchangeRequestHandler,
  DidExchangeResponseHandler,
  DidExchangeCompleteHandler,
} from './handlers'
import { HandshakeProtocol } from './models'
import { ConnectionRepository } from './repository'
import { ConnectionService } from './services/ConnectionService'
import { TrustPingService } from './services/TrustPingService'

@module()
@injectable()
export class ConnectionsModule {
  private agentConfig: AgentConfig
  private didExchangeProtocol: DidExchangeProtocol
  private connectionService: ConnectionService
  private outOfBandService: OutOfBandService
  private messageSender: MessageSender
  private trustPingService: TrustPingService
  private routingService: RoutingService
  private didRepository: DidRepository
  private didResolverService: DidResolverService

  public constructor(
    dispatcher: Dispatcher,
    agentConfig: AgentConfig,
    didExchangeProtocol: DidExchangeProtocol,
    connectionService: ConnectionService,
    outOfBandService: OutOfBandService,
    trustPingService: TrustPingService,
    routingService: RoutingService,
    didRepository: DidRepository,
    didResolverService: DidResolverService,
    messageSender: MessageSender
  ) {
    this.agentConfig = agentConfig
    this.didExchangeProtocol = didExchangeProtocol
    this.connectionService = connectionService
    this.outOfBandService = outOfBandService
    this.trustPingService = trustPingService
    this.routingService = routingService
    this.didRepository = didRepository
    this.messageSender = messageSender
    this.didResolverService = didResolverService
    this.registerHandlers(dispatcher)
  }

  public async acceptOutOfBandInvitation(
    outOfBandRecord: OutOfBandRecord,
    config: {
      autoAcceptConnection?: boolean
      label?: string
      alias?: string
      imageUrl?: string
      protocol: HandshakeProtocol
      routing?: Routing
    }
  ) {
    const { protocol, label, alias, imageUrl, autoAcceptConnection } = config

    const routing = config.routing || (await this.routingService.getRouting({ mediatorId: outOfBandRecord.mediatorId }))

    let result
    if (protocol === HandshakeProtocol.DidExchange) {
      result = await this.didExchangeProtocol.createRequest(outOfBandRecord, {
        label,
        alias,
        routing,
        autoAcceptConnection,
      })
    } else if (protocol === HandshakeProtocol.Connections) {
      result = await this.connectionService.createRequest(outOfBandRecord, {
        label,
        alias,
        imageUrl,
        routing,
        autoAcceptConnection,
      })
    } else {
      throw new AriesFrameworkError(`Unsupported handshake protocol ${protocol}.`)
    }

    const { message, connectionRecord } = result
    const outboundMessage = createOutboundMessage(connectionRecord, message, outOfBandRecord)
    await this.messageSender.sendMessage(outboundMessage)
    return connectionRecord
  }

  /**
   * Accept a connection request as inviter (by sending a connection response message) for the connection with the specified connection id.
   * This is not needed when auto accepting of connection is enabled.
   *
   * @param connectionId the id of the connection for which to accept the request
   * @returns connection record
   */
  public async acceptRequest(connectionId: string): Promise<ConnectionRecord> {
    const connectionRecord = await this.connectionService.findById(connectionId)
    if (!connectionRecord) {
      throw new AriesFrameworkError(`Connection record ${connectionId} not found.`)
    }
    if (!connectionRecord.outOfBandId) {
      throw new AriesFrameworkError(`Connection record ${connectionId} does not have out-of-band record.`)
    }

    const outOfBandRecord = await this.outOfBandService.findById(connectionRecord.outOfBandId)
    if (!outOfBandRecord) {
      throw new AriesFrameworkError(`Out-of-band record ${connectionRecord.outOfBandId} not found.`)
    }

    let outboundMessage
    if (connectionRecord.protocol === HandshakeProtocol.DidExchange) {
      const message = await this.didExchangeProtocol.createResponse(connectionRecord, outOfBandRecord)
      outboundMessage = createOutboundMessage(connectionRecord, message)
    } else {
      const { message } = await this.connectionService.createResponse(connectionRecord, outOfBandRecord)
      outboundMessage = createOutboundMessage(connectionRecord, message)
    }

    await this.messageSender.sendMessage(outboundMessage)
    return connectionRecord
  }

  /**
   * Accept a connection response as invitee (by sending a trust ping message) for the connection with the specified connection id.
   * This is not needed when auto accepting of connection is enabled.
   *
   * @param connectionId the id of the connection for which to accept the response
   * @returns connection record
   */
  public async acceptResponse(connectionId: string): Promise<ConnectionRecord> {
    const connectionRecord = await this.connectionService.getById(connectionId)

    let outboundMessage
    if (connectionRecord.protocol === HandshakeProtocol.DidExchange) {
      if (!connectionRecord.outOfBandId) {
        throw new AriesFrameworkError(`Connection ${connectionRecord.id} does not have outOfBandId!`)
      }
      const outOfBandRecord = await this.outOfBandService.findById(connectionRecord.outOfBandId)
      if (!outOfBandRecord) {
        throw new AriesFrameworkError(
          `OutOfBand record for connection ${connectionRecord.id} with outOfBandId ${connectionRecord.outOfBandId} not found!`
        )
      }
      const message = await this.didExchangeProtocol.createComplete(connectionRecord, outOfBandRecord)
      // Disable return routing as we don't want to receive a response for this message over the same channel
      // This has led to long timeouts as not all clients actually close an http socket if there is no response message
      message.setReturnRouting(ReturnRouteTypes.none)
      outboundMessage = createOutboundMessage(connectionRecord, message)
    } else {
      const { message } = await this.connectionService.createTrustPing(connectionRecord, {
        responseRequested: false,
      })
      // Disable return routing as we don't want to receive a response for this message over the same channel
      // This has led to long timeouts as not all clients actually close an http socket if there is no response message
      message.setReturnRouting(ReturnRouteTypes.none)
      outboundMessage = createOutboundMessage(connectionRecord, message)
    }

    await this.messageSender.sendMessage(outboundMessage)
    return connectionRecord
  }

  public async returnWhenIsConnected(connectionId: string, options?: { timeoutMs: number }): Promise<ConnectionRecord> {
    return this.connectionService.returnWhenIsConnected(connectionId, options?.timeoutMs)
  }

  /**
   * Retrieve all connections records
   *
   * @returns List containing all connection records
   */
  public getAll() {
    return this.connectionService.getAll()
  }

  /**
   * Allows for the addition of connectionType to the record.
   *  Either updates or creates an array of string conection types
   * @param connectionId
   * @param type
   * @throws {RecordNotFoundError} If no record is found
   */
  public async addConnectionType(connectionId: string, type: ConnectionType | string) {
    const record = await this.getById(connectionId)

    const tags = (record.getTag('connectionType') as string[]) || ([] as string[])
    record.setTag('connectionType', [type, ...tags])
    await this.connectionService.update(record)
  }
  /**
   * Removes the given tag from the given record found by connectionId, if the tag exists otherwise does nothing
   * @param connectionId
   * @param type
   * @throws {RecordNotFoundError} If no record is found
   */
  public async removeConnectionType(connectionId: string, type: ConnectionType | string) {
    const record = await this.getById(connectionId)

    const tags = (record.getTag('connectionType') as string[]) || ([] as string[])

    const newTags = tags.filter((value: string) => {
      if (value != type) return value
    })
    record.setTag('connectionType', [...newTags])

    await this.connectionService.update(record)
  }
  /**
   * Gets the known connection types for the record matching the given connectionId
   * @param connectionId
   * @returns An array of known connection types or null if none exist
   * @throws {RecordNotFoundError} If no record is found
   */
  public async getConnectionTypes(connectionId: string) {
    const record = await this.getById(connectionId)
    const tags = record.getTag('connectionType') as string[]
    return tags || null
  }

  /**
   *
   * @param connectionTypes An array of connection types to query for a match for
   * @returns a promise of ab array of connection records
   */
  public async findAllByConnectionType(connectionTypes: [ConnectionType | string]) {
    return this.connectionService.findAllByConnectionType(connectionTypes)
  }

  /**
   * Retrieve a connection record by id
   *
   * @param connectionId The connection record id
   * @throws {RecordNotFoundError} If no record is found
   * @return The connection record
   *
   */
  public getById(connectionId: string): Promise<ConnectionRecord> {
    return this.connectionService.getById(connectionId)
  }

  /**
   * Find a connection record by id
   *
   * @param connectionId the connection record id
   * @returns The connection record or null if not found
   */
  public findById(connectionId: string): Promise<ConnectionRecord | null> {
    return this.connectionService.findById(connectionId)
  }

  /**
   * Delete a connection record by id
   *
   * @param connectionId the connection record id
   */
  public async deleteById(connectionId: string) {
    return this.connectionService.deleteById(connectionId)
  }

  public async findByKeys({ senderKey, recipientKey }: { senderKey: Key; recipientKey: Key }) {
    const theirDidRecord = await this.didRepository.findByRecipientKey(senderKey)
    if (theirDidRecord) {
      const ourDidRecord = await this.didRepository.findByRecipientKey(recipientKey)
      if (ourDidRecord) {
        const connectionRecord = await this.connectionService.findSingleByQuery({
          did: ourDidRecord.id,
          theirDid: theirDidRecord.id,
        })
        if (connectionRecord && connectionRecord.isReady) return connectionRecord
      }
    }

    this.agentConfig.logger.debug(
      `No connection record found for encrypted message with recipient key ${recipientKey.fingerprint} and sender key ${senderKey.fingerprint}`
    )

    return null
  }

  public async findAllByOutOfBandId(outOfBandId: string) {
    return this.connectionService.findAllByOutOfBandId(outOfBandId)
  }

  /**
   * Retrieve a connection record by thread id
   *
   * @param threadId The thread id
   * @throws {RecordNotFoundError} If no record is found
   * @throws {RecordDuplicateError} If multiple records are found
   * @returns The connection record
   */
  public getByThreadId(threadId: string): Promise<ConnectionRecord> {
    return this.connectionService.getByThreadId(threadId)
  }

  public async findByDid(did: string): Promise<ConnectionRecord | null> {
    return this.connectionService.findByTheirDid(did)
  }

  public async findByInvitationDid(invitationDid: string): Promise<ConnectionRecord[]> {
    return this.connectionService.findByInvitationDid(invitationDid)
  }

  private registerHandlers(dispatcher: Dispatcher) {
    dispatcher.registerHandler(
      new ConnectionRequestHandler(
        this.agentConfig,
        this.connectionService,
        this.outOfBandService,
        this.routingService,
        this.didRepository
      )
    )
    dispatcher.registerHandler(
      new ConnectionResponseHandler(
        this.agentConfig,
        this.connectionService,
        this.outOfBandService,
        this.didResolverService
      )
    )
    dispatcher.registerHandler(new AckMessageHandler(this.connectionService))
    dispatcher.registerHandler(new TrustPingMessageHandler(this.trustPingService, this.connectionService))
    dispatcher.registerHandler(new TrustPingResponseMessageHandler(this.trustPingService))

    dispatcher.registerHandler(
      new DidExchangeRequestHandler(
        this.agentConfig,
        this.didExchangeProtocol,
        this.outOfBandService,
        this.routingService,
        this.didRepository
      )
    )

    dispatcher.registerHandler(
      new DidExchangeResponseHandler(
        this.agentConfig,
        this.didExchangeProtocol,
        this.outOfBandService,
        this.connectionService,
        this.didResolverService
      )
    )
    dispatcher.registerHandler(new DidExchangeCompleteHandler(this.didExchangeProtocol, this.outOfBandService))
  }

  /**
   * Registers the dependencies of the connections module on the dependency manager.
   */
  public static register(dependencyManager: DependencyManager) {
    // Api
    dependencyManager.registerContextScoped(ConnectionsModule)

    // Services
    dependencyManager.registerSingleton(ConnectionService)
    dependencyManager.registerSingleton(DidExchangeProtocol)
    dependencyManager.registerSingleton(TrustPingService)

    // Repositories
    dependencyManager.registerSingleton(ConnectionRepository)
  }
}
