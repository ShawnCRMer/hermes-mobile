import { useState, useEffect, memo } from 'react'
import {
  getLocalState,
  isLocalEnabled,
  onLocalProgress,
  type LocalGatewayState,
} from '../bridge/local-connection'
import { getOnDeviceStatus, onModelStatusChanged } from '../bridge/model-manager'
import { openSheet as openModelManager } from '../bridge/model-manager-ui'

function localIsActive(state: LocalGatewayState): boolean {
  return isLocalEnabled() && state.enabled && state.phase === 'ready'
}

export const LocalModelBar = memo(function LocalModelBar() {
  const [active, setActive] = useState(() => localIsActive(getLocalState()))
  const [activeModel, setActiveModel] = useState<string | null>(null)

  useEffect(() => {
    const refreshModel = () => setActiveModel(getOnDeviceStatus().activeModelId)

    refreshModel()
    setActive(localIsActive(getLocalState()))
    const unsub1 = onLocalProgress(state => setActive(localIsActive(state)))
    const unsub2 = onModelStatusChanged(refreshModel)
    return () => { unsub1(); unsub2() }
  }, [])

  if (!active) return null

  const modelName = activeModel
    ? activeModel.replace(/-4bit$/i, '').replace(/-/g, ' ')
    : null

  return (
    <div className="local-model-bar">
      <div className="local-model-bar__label">
        <span className={`local-model-bar__dot ${modelName ? 'local-model-bar__dot--active' : 'local-model-bar__dot--idle'}`} />
        {modelName ? (
          <span className="local-model-bar__name">{modelName}</span>
        ) : (
          <span>No model loaded</span>
        )}
      </div>
      <button className="local-model-bar__action" onClick={openModelManager}>
        Models
      </button>
    </div>
  )
})
