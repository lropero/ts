#!/usr/bin/env node
/**
 * Copyright (c) 2023, Luciano Ropero <lropero@gmail.com>
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

import _ from 'lodash'
import blessed from 'blessed'
import cfonts from 'cfonts'
import chalk from 'chalk'
import figures from 'figures'
import jsonfile from 'jsonfile'
import WebSocket from 'ws'
import { format } from 'date-fns'
import { program } from 'commander'

const BINANCE = 'wss://fstream.binance.com/ws'
const HIGHWAY = { deltas: 100, level: 320 }

const store = {}

const addBox = type => {
  const { screen, symbol } = store
  switch (type) {
    case 'disconnected': {
      const box = blessed.box({ content: 'disconnected, attempting to reconnect...', height: 1, left: Math.round(screen.width / 2) - 20, style: { bg: 'red' }, top: 3, width: 40 })
      append({ box, type })
      break
    }
    case 'display': {
      const priceBox = blessed.box({ height: 2, left: symbol.length * 4 + 1, style: { bg: 'black' } })
      const symbolBox = blessed.box({ height: 2, style: { bg: 'black' } })
      append({ box: symbolBox, type: 'symbol' })
      append({ box: priceBox, type: 'price' })
      break
    }
    case 'info': {
      const box = blessed.box({ height: 1, style: { bg: 'black' }, top: 2, width: screen.width })
      append({ box, type })
      break
    }
    case 'tape': {
      const box = blessed.box({ height: screen.height - 3, style: { bg: 'black' }, top: 3, width: screen.width })
      append({ box, type })
      break
    }
  }
}

const addBoxes = () => {
  const { boxes } = store
  const types = ['tape', 'info', 'display']
  types.forEach(type => addBox(type))
  boxes.disconnected && addBox('disconnected')
}

const append = ({ box, type }) => {
  const { boxes, screen } = store
  if (boxes[type]) {
    screen.remove(boxes[type])
  }
  screen.append(box)
  updateStore({ boxes: { ...boxes, [type]: box } })
}

const calculateLevel = price => {
  const { lastTrade } = store
  if (!lastTrade) {
    return 0
  }
  const delta = Math.abs(price - lastTrade.price)
  if (delta > 0) {
    const { deltas } = store
    deltas.push(delta)
    if (deltas.length > HIGHWAY.deltas) {
      do {
        deltas.shift()
      } while (deltas.length > HIGHWAY.deltas)
    }
    const average = deltas.reduce((average, delta) => average + delta, 0) / deltas.length
    let level = lastTrade.level
    if (price < lastTrade.price) {
      level -= Math.round((delta / average) * 8)
    } else if (price > lastTrade.price) {
      level += Math.round((delta / average) * 8)
    }
    if (level > HIGHWAY.level) {
      level = HIGHWAY.level
    } else if (level < -HIGHWAY.level) {
      level = -HIGHWAY.level
    }
    return level
  }
  return lastTrade.level
}

const connect = () => {
  const { symbol, timers, webSocket } = store
  timers.list && clearInterval(timers.list)
  webSocket.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${symbol.toLowerCase()}@aggTrade`] }))
  timers.list = setInterval(() => {
    const { webSocket } = store
    webSocket.send(JSON.stringify({ id: 1337, method: 'LIST_SUBSCRIPTIONS' }))
  }, 25000)
  resetWatchdog()
}

const createWebSocket = () =>
  new Promise((resolve, reject) => {
    const webSocket = new WebSocket(BINANCE)
    webSocket.on('error', error => reject(error))
    webSocket.on('message', message => {
      const { e, ...rest } = JSON.parse(message)
      switch (e) {
        case 'aggTrade': {
          updateStore({ trade: rest })
          break
        }
        default: {
          if (rest.id === 1337 && rest.result.length === 1) {
            resetWatchdog()
          }
        }
      }
    })
    webSocket.on('open', () => resolve(webSocket))
  })

const draw = () => {
  const { boxes, currency, directionColor, header, lastTrade, screen, speed, symbol, trades } = store
  if (lastTrade) {
    const symbolRender = cfonts.render(symbol, { colors: ['white'], font: 'tiny', space: false })
    boxes.symbol.setContent(symbolRender.string)
    const priceRender = cfonts.render(currency.format(lastTrade.price), { colors: [directionColor], font: 'tiny', space: false })
    boxes.price.setContent(priceRender.string)
  }
  let ratio = 0
  if (speed.buy.toFixed(2) !== '0.00' && speed.sell.toFixed(2) !== '0.00') {
    if (speed.buy > speed.sell) {
      ratio = speed.buy / speed.sell
    } else if (speed.sell > speed.buy) {
      ratio = speed.sell / speed.buy
    }
  }
  boxes.info.setContent(` ${header} ${chalk.white(speed.tick)}${chalk.yellow(`/m (${chalk.cyan(speed.buy.toFixed(2))}/${chalk.magenta(speed.sell.toFixed(2))}${ratio > 0 ? `=${chalk[speed.buy > speed.sell ? 'black' : 'white'](chalk[speed.buy > speed.sell ? 'bgCyan' : 'bgMagenta'](ratio.toFixed(2)))}` : ''})`)}`)
  const slice = trades.slice(0, screen.height - 3)
  if (slice.length > 0) {
    if (screen.height - 3 > 0) {
      boxes.tape.setContent(slice.map(trade => ` ${trade}`).join('\n'))
    } else {
      boxes.tape.setContent('')
    }
  }
  screen.render()
}

const getLine = trade => {
  const level = Math.abs(trade.level)
  const blocks = Math.floor(level / 8)
  const eighths = level - blocks * 8
  return `${chalk[trade.level > 0 ? 'green' : 'red'](`${'\u2588'.repeat(blocks)}${getPartialBlock(eighths)}`)}${' '.repeat(40 - blocks - (eighths ? 1 : 0))}`
}

const getPartialBlock = eighths => {
  switch (eighths) {
    case 0:
      return ''
    case 1:
      return '\u258F'
    case 2:
      return '\u258E'
    case 3:
      return '\u258D'
    case 4:
      return '\u258C'
    case 5:
      return '\u258B'
    case 6:
      return '\u258A'
    case 7:
      return '\u2589'
  }
}

const resetWatchdog = () => {
  const { timers } = store
  timers.reconnect && clearTimeout(timers.reconnect)
  timers.reconnect = setTimeout(async () => {
    addBox('disconnected')
    try {
      const webSocket = await createWebSocket()
      updateStore({ webSocket })
    } catch (error) {
      resetWatchdog()
    }
  }, 60000)
}

const start = title => {
  const { screen } = store
  addBoxes()
  screen.key('q', process.exit)
  screen.on('resize', _.debounce(addBoxes, 500))
  screen.title = title
  updateStore({ initialized: true })
  connect()
  setInterval(draw, 50)
}

const updateStore = updates => {
  const { initialized } = store
  Object.keys(updates).forEach(key => {
    if (!initialized) {
      store[key] = updates[key]
    } else {
      switch (key) {
        case 'trade': {
          const { block, boxes, cap, currency, directionColor, filter, lastTrade, market, screen, trades } = store
          const { m: marketMaker, p: price, q: quantity, T: tradeTime } = updates[key]
          const trade = { marketMaker, price: parseFloat(price), quantity: parseFloat(quantity), tradeTime }
          if (boxes.disconnected) {
            screen.remove(boxes.disconnected)
            delete boxes.disconnected
          }
          trade.level = calculateLevel(trade.price)
          if ((cap === 0 || trade.quantity < cap) && (filter === 0 || trade.quantity >= filter) && (market === '' || (market === 'buy' && !trade.marketMaker) || (market === 'sell' && trade.marketMaker))) {
            store.speed.tick++
            if (trade.marketMaker) {
              store.speed.sell += trade.quantity
            } else {
              store.speed.buy += trade.quantity
            }
            setTimeout(() => {
              store.speed.tick--
              if (trade.marketMaker) {
                store.speed.sell -= trade.quantity
              } else {
                store.speed.buy -= trade.quantity
              }
            }, 60000)
            trades.unshift(`${chalk.white(format(trade.tradeTime, 'HH:mm'))} ${chalk[trade.marketMaker ? 'magenta' : 'cyan'](currency.format(trade.price))}${chalk.yellow('\u2595')}${getLine(trade)}${chalk.yellow('\u258F')}${chalk[trade.marketMaker ? (block > 0 && trade.quantity >= block ? 'bgMagenta' : 'magenta') : block > 0 && trade.quantity >= block ? 'bgCyan' : 'cyan'](trade.quantity)}`)
            if (trades.length > 500) {
              do {
                trades.pop()
              } while (trades.length > 500)
            }
          }
          updateStore({ directionColor: trade.price > lastTrade?.price ? 'green' : trade.price < lastTrade?.price ? 'red' : directionColor ?? 'white', lastTrade: trade })
          break
        }
        case 'webSocket': {
          const { webSocket } = store
          webSocket && webSocket.terminate()
          store.webSocket = updates[key]
          connect()
          break
        }
        default: {
          store[key] = updates[key]
        }
      }
    }
  })
}

program
  .argument('<symbol>', 'symbol')
  .option('-b, --block <size>', 'mark block quantity (default 0)', 0)
  .option('-c, --cap <size>', 'exclude more than quantity (default 0)', 0)
  .option('-f, --filter <size>', 'exclude less than quantity (default 0)', 0)
  .option('-m, --market <type>', 'show only "buy" or "sell" orders')
  .action(async (symbol, options) => {
    try {
      const { name, version } = await jsonfile.readFile('./package.json')
      const block = parseFloat(options.block) > 0 ? parseFloat(options.block) : 0
      const cap = parseFloat(options.cap) > 0 ? parseFloat(options.cap) : 0
      const filter = parseFloat(options.filter) > 0 ? parseFloat(options.filter) : 0
      const market = ['buy', 'sell'].includes((options.market ?? '').toLowerCase()) ? options.market.toLowerCase() : ''
      const header = chalk.white(`${chalk.green(`${name.charAt(0).toUpperCase()}${name.slice(1)}`)} v${version} - ${chalk.cyan('q')}uit ${chalk.yellow(`${block > 0 ? `-b ${block} ` : ''}${cap > 0 ? `-c ${cap} ` : ''}${filter > 0 ? `-f ${filter} ` : ''}${market.length > 0 ? `-m ${market}` : ''}`.trimEnd())}`)
      const webSocket = await createWebSocket()
      const screen = blessed.screen({ forceUnicode: true, fullUnicode: true, smartCSR: true })
      updateStore({ block, boxes: {}, cap, currency: new Intl.NumberFormat('en-US', { currency: 'USD', minimumFractionDigits: 2, style: 'currency' }), deltas: [], filter, header, market, screen, speed: { buy: 0, sell: 0, tick: 0 }, symbol, timers: {}, trades: [], webSocket })
      start(`${name.charAt(0).toUpperCase()}${name.slice(1)} v${version}`)
    } catch (error) {
      console.log(`${chalk.red(figures.cross)} ${error.toString()}`)
      process.exit()
    }
  })
  .parse(process.argv)
