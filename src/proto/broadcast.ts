/**
 * Protobuf definitions for Bilibili Broadcast WebSocket protocol
 * Extracted from the official Bilibili web client
 */

import { Root, type Type } from 'protobufjs'

// Proto definitions in JSON format for protobufjs
export const broadcastProtoJSON = {
  nested: {
    bilibili: {
      nested: {
        broadcast: {
          nested: {
            v1: {
              nested: {
                AuthReq: {
                  fields: {
                    guid: { type: 'string', id: 1 },
                    connId: { type: 'string', id: 2 },
                    lastMsgId: { type: 'int64', id: 3 },
                  },
                },
                AuthResp: {
                  fields: {},
                },
                HeartbeatReq: {
                  fields: {},
                },
                HeartbeatResp: {
                  fields: {},
                },
                TargetPath: {
                  fields: {
                    targetPaths: { rule: 'repeated', type: 'string', id: 1 },
                  },
                },
                MessageAckReq: {
                  fields: {
                    ackId: { type: 'int64', id: 1 },
                    ackOrigin: { type: 'string', id: 2 },
                    targetPath: { type: 'string', id: 3 },
                    msgType: { type: 'int64', id: 4 },
                  },
                },
                Subscribe: {
                  fields: {
                    type: { type: 'string', id: 1 },
                    targetPaths: { rule: 'repeated', type: 'string', id: 2 },
                  },
                },
                Status: {
                  fields: {
                    code: { type: 'int32', id: 1 },
                    message: { type: 'string', id: 2 },
                    details: { rule: 'repeated', type: 'google.protobuf.Any', id: 3 },
                  },
                },
                FrameOption: {
                  fields: {
                    messageId: { type: 'int64', id: 1 },
                    sequence: { type: 'int64', id: 2 },
                    isAck: { type: 'bool', id: 3 },
                    status: { type: 'Status', id: 4 },
                    ackOrigin: { type: 'string', id: 5 },
                    timestamp: { type: 'int64', id: 6 },
                    msgType: { type: 'int64', id: 7 },
                  },
                },
                BroadcastFrame: {
                  fields: {
                    options: { type: 'FrameOption', id: 1 },
                    targetPath: { type: 'string', id: 2 },
                    body: { type: 'google.protobuf.Any', id: 3 },
                  },
                },
                RoomJoinEvent: {
                  fields: {},
                },
                RoomLeaveEvent: {
                  fields: {},
                },
                RoomOnlineEvent: {
                  fields: {
                    online: { type: 'int32', id: 1 },
                    allOnline: { type: 'int32', id: 2 },
                  },
                },
                RoomMessageEvent: {
                  fields: {
                    targetPath: { type: 'string', id: 1 },
                    body: { type: 'google.protobuf.Any', id: 2 },
                  },
                },
                RoomErrorEvent: {
                  fields: {
                    status: { type: 'Status', id: 1 },
                  },
                },
                RoomReq: {
                  oneofs: {
                    event: { oneof: ['join', 'leave', 'online', 'msg'] },
                  },
                  fields: {
                    id: { type: 'string', id: 1 },
                    join: { type: 'RoomJoinEvent', id: 2 },
                    leave: { type: 'RoomLeaveEvent', id: 3 },
                    online: { type: 'RoomOnlineEvent', id: 4 },
                    msg: { type: 'RoomMessageEvent', id: 5 },
                  },
                },
                RoomResp: {
                  oneofs: {
                    event: { oneof: ['join', 'leave', 'online', 'msg', 'err'] },
                  },
                  fields: {
                    id: { type: 'string', id: 1 },
                    join: { type: 'RoomJoinEvent', id: 2 },
                    leave: { type: 'RoomLeaveEvent', id: 3 },
                    online: { type: 'RoomOnlineEvent', id: 4 },
                    msg: { type: 'RoomMessageEvent', id: 5 },
                    err: { type: 'RoomErrorEvent', id: 6 },
                  },
                },
              },
            },
            message: {
              nested: {
                im: {
                  nested: {
                    PLType: {
                      values: {
                        EN_PAYLOAD_NORMAL: 0,
                        EN_PAYLOAD_BASE64: 1,
                      },
                    },
                    CmdId: {
                      values: {
                        EN_CMD_ID_INVALID: 0,
                        EN_CMD_ID_MSG_NOTIFY: 1,
                        EN_CMD_ID_KICK_OUT: 2,
                      },
                    },
                    NotifyRsp: {
                      fields: {
                        uid: { type: 'uint64', id: 1 },
                        cmd: { type: 'uint64', id: 2 },
                        payload: { type: 'ReqServerNotify', id: 3 },
                        payloadType: { type: 'PLType', id: 4 },
                      },
                    },
                    Msg: {
                      fields: {
                        senderUid: { type: 'uint64', id: 1 },
                        receiverType: { type: 'int32', id: 2 },
                        receiverId: { type: 'uint64', id: 3 },
                        cliMsgId: { type: 'uint64', id: 4 },
                        msgType: { type: 'int32', id: 5 },
                        content: { type: 'string', id: 6 },
                        msgSeqno: { type: 'uint64', id: 7 },
                        timestamp: { type: 'uint64', id: 8 },
                        atUids: { rule: 'repeated', type: 'uint64', id: 9 },
                        recverIds: { rule: 'repeated', type: 'uint64', id: 10 },
                        msgKey: { type: 'uint64', id: 11 },
                        msgStatus: { type: 'uint32', id: 12 },
                        sysCancel: { type: 'bool', id: 13 },
                        isMultiChat: { type: 'uint32', id: 14 },
                        withdrawSeqno: { type: 'uint64', id: 15 },
                        notifyCode: { type: 'string', id: 16 },
                        msgSource: { type: 'uint32', id: 17 },
                      },
                    },
                    NotifyInfo: {
                      fields: {
                        msgType: { type: 'uint32', id: 1 },
                        talkerId: { type: 'uint64', id: 2 },
                        sessionType: { type: 'uint32', id: 3 },
                      },
                    },
                    ReqServerNotify: {
                      fields: {
                        lastestSeqno: { type: 'uint64', id: 1 },
                        instantMsg: { type: 'Msg', id: 2 },
                        notifyInfo: { type: 'NotifyInfo', id: 3 },
                        commandMsgs: { rule: 'repeated', type: 'CommandMsg', id: 4 },
                      },
                    },
                    CommandMsg: {
                      oneofs: {
                        command: {
                          oneof: [
                            'updateTotalUnreadCommand',
                            'updateSessionListCommand',
                            'updateQuickLinkCommand',
                            'fetchMessageCommand',
                          ],
                        },
                      },
                      fields: {
                        updateTotalUnreadCommand: { type: 'UpdateTotalUnreadCommand', id: 1 },
                        updateSessionListCommand: { type: 'UpdateSessionListCommand', id: 2 },
                        updateQuickLinkCommand: { type: 'UpdateQuickLinkCommand', id: 3 },
                        fetchMessageCommand: { type: 'FetchMessageCommand', id: 4 },
                      },
                    },
                    UpdateTotalUnreadCommand: {
                      fields: {},
                    },
                    UpdateSessionListCommand: {
                      fields: {
                        sessionId: { type: 'SessionId', id: 1 },
                      },
                    },
                    UpdateQuickLinkCommand: {
                      fields: {},
                    },
                    FetchMessageCommand: {
                      fields: {
                        sessionId: { type: 'SessionId', id: 1 },
                      },
                    },
                    SessionId: {
                      oneofs: {
                        id: { oneof: ['privateId', 'groupId', 'foldId', 'systemId', 'customerId'] },
                      },
                      fields: {
                        privateId: { type: 'PrivateId', id: 1 },
                        groupId: { type: 'GroupId', id: 2 },
                        foldId: { type: 'FoldId', id: 3 },
                        systemId: { type: 'SystemId', id: 4 },
                        customerId: { type: 'CustomerId', id: 5 },
                      },
                    },
                    PrivateId: {
                      fields: {
                        uid: { type: 'uint64', id: 1 },
                      },
                    },
                    GroupId: {
                      fields: {
                        groupId: { type: 'uint64', id: 1 },
                      },
                    },
                    FoldId: {
                      fields: {
                        foldType: { type: 'uint32', id: 1 },
                      },
                    },
                    SystemId: {
                      fields: {
                        systemMsgType: { type: 'uint32', id: 1 },
                      },
                    },
                    CustomerId: {
                      fields: {
                        customerId: { type: 'uint64', id: 1 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    google: {
      nested: {
        protobuf: {
          nested: {
            Empty: {
              fields: {},
            },
            Any: {
              fields: {
                type_url: { type: 'string', id: 1 },
                value: { type: 'bytes', id: 2 },
              },
            },
          },
        },
      },
    },
  },
}

// Create protobuf root from JSON definition
let _root: Root | null = null

export function getProtoRoot(): Root {
  if (!_root) {
    _root = Root.fromJSON(broadcastProtoJSON)
  }
  return _root
}

// Helper function to get message types
export function getMessageType(typeName: string): Type {
  const root = getProtoRoot()
  return root.lookupType(typeName)
}

// Common message type paths
export const MessageTypes = {
  // bilibili.broadcast.v1
  AuthReq: 'bilibili.broadcast.v1.AuthReq',
  AuthResp: 'bilibili.broadcast.v1.AuthResp',
  HeartbeatReq: 'bilibili.broadcast.v1.HeartbeatReq',
  HeartbeatResp: 'bilibili.broadcast.v1.HeartbeatResp',
  Subscribe: 'bilibili.broadcast.v1.Subscribe',
  TargetPath: 'bilibili.broadcast.v1.TargetPath',
  BroadcastFrame: 'bilibili.broadcast.v1.BroadcastFrame',
  FrameOption: 'bilibili.broadcast.v1.FrameOption',
  MessageAckReq: 'bilibili.broadcast.v1.MessageAckReq',

  // bilibili.broadcast.message.im
  NotifyRsp: 'bilibili.broadcast.message.im.NotifyRsp',
  Msg: 'bilibili.broadcast.message.im.Msg',
  NotifyInfo: 'bilibili.broadcast.message.im.NotifyInfo',
  ReqServerNotify: 'bilibili.broadcast.message.im.ReqServerNotify',
  CommandMsg: 'bilibili.broadcast.message.im.CommandMsg',

  // google.protobuf
  Any: 'google.protobuf.Any',
  Empty: 'google.protobuf.Empty',
} as const

// Target paths for subscription
export const TargetPaths = {
  WatchNotify: '/bilibili.broadcast.message.im.Notify/WatchNotify',
} as const
