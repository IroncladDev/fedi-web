import {
  PermissionLevel,
  permissions,
  promptHeight,
  promptWidth,
} from "@common/constants"
import { sendExtensionMessage } from "@common/messaging/extension"
import { extensionMessage, messageModuleCall } from "@common/schemas"
import {
  ExtensionMessage,
  MessageModuleCall,
  MessagePromptChoice,
} from "@common/types"
import browser from "webextension-polyfill"
import { initWallet } from ".."
import handleFedimintMessage, { FedimintParams } from "../handlers/fedimint"
import handleNostrMessage, { NostrParams } from "../handlers/nostr"
import handleWeblnMessage, { WeblnParams } from "../handlers/webln"
import {
  promptMutex,
  releasePromptMutex,
  setReleasePromptMutex,
  setWindowPrompt,
  wallet,
} from "../state"
import handleInternalMessage from "./internal"
import { handlePromptMessage } from "./prompt"

export async function handleMessage(msg: ExtensionMessage, sender: any) {
  const message = extensionMessage.parse(msg)

  try {
    switch (message.type) {
      case "prompt":
        handlePromptMessage(msg as MessagePromptChoice, sender)
        break
      case "methodCall":
        const methodRes = await handleContentScriptMessage(message)

        return { success: true, data: methodRes }
      case "internalCall":
        const internalRes = await handleInternalMessage(message)

        return { success: true, data: internalRes }
      case "balanceRequest":
        if (wallet.isOpen()) {
          sendExtensionMessage({
            type: "balance",
            balance: await wallet.balance.getBalance(),
          })
        }
      default:
        return
    }
  } catch (err) {
    return { success: false, message: (err as Error).message }
  }
}

async function handleContentScriptMessage(msg: MessageModuleCall) {
  const {
    module,
    method,
    windowPos,
    params: messageParams,
  } = messageModuleCall.parse(msg)

  // Prompt URL may change original params (e.g. webln.creatInvoice)
  let params = messageParams

  try {
    await initWallet()

    let result: MessagePromptChoice = {
      type: "prompt",
      accept: true,
      method,
      params,
    }

    if (permissions[module][method] !== PermissionLevel.None) {
      setReleasePromptMutex(await promptMutex.acquire())

      result = await new Promise<MessagePromptChoice>(
        async (resolve, reject) => {
          setWindowPrompt({ resolve, reject })

          let queryParams = new URLSearchParams({
            params: JSON.stringify(params),
            module,
            method,
          })

          const win = await browser.windows.create({
            url: `${browser.runtime.getURL(
              "src/prompt/prompt.html",
            )}?${queryParams.toString()}`,
            type: "popup",
            width: promptWidth,
            height: promptHeight,
            top: Math.round(windowPos[1]),
            left: Math.round(windowPos[0]),
          })

          function listenForClose(id?: number) {
            if (id === win.id) {
              resolve({
                type: "prompt",
                accept: false,
                method,
              })
              browser.windows.onRemoved.removeListener(listenForClose)
            }
          }

          browser.windows.onRemoved.addListener(listenForClose)
        },
      )
    }

    // TODO: better error handling
    if (!result.accept) throw new Error("denied")

    params = result.params
  } catch (err) {
    releasePromptMutex()

    throw new Error((err as Error).message)
  }

  if (module === "fedimint") {
    return await handleFedimintMessage(
      {
        method,
        params,
      } as FedimintParams,
      wallet,
    )
  } else if (module === "nostr") {
    return await handleNostrMessage({
      method,
      params,
    } as NostrParams)
  } else if (module === "webln") {
    return await handleWeblnMessage(
      {
        method,
        params,
      } as WeblnParams,
      wallet,
    )
  }
}
