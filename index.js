const jackettApi = require('./jackett')
const helper = require('./helpers')

const parseTorrent = require('parse-torrent')
const async = require('async')
const {cinemeta, config} = require('internal')

const formatBytes = (bytes, decimals = 2) => {
    if (!+bytes) return '0 Bytes'

    const k = 1024
    const dm = decimals < 0 ? 0 : decimals
    const sizes = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB']

    const i = Math.floor(Math.log(bytes) / Math.log(k))

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}
const streamFromMagnet = (tor, uri, type, cb) => {
    const toStream = (parsed) => {

        const infoHash = parsed.infoHash.toLowerCase()

        let title = tor.title || parsed.name
        const size = '📀 ' + formatBytes(tor.size)
        const subtitle = '🛰️ ' + tor.seeders
        const quality = '💎 ' + tor.extraTag

        title += '\r\n' + size
        title += '\r\n' + subtitle
        title += '\r\n' + quality


        let trackers = (parsed.announce || []).map(x => {
            return "tracker:" + x
        })

        if (trackers.length && (!config.dhtEnabled || config.dhtEnabled == 'True'))
            trackers = trackers.concat(["dht:" + infoHash])

        const streamObj = {
            name: tor.from,
            type: type,
            infoHash: infoHash,
            title: title
        }

        if (trackers.length)
            streamObj.sources = trackers

        cb(streamObj)
    }

    if (uri.startsWith("magnet:?")) {
        toStream(parseTorrent(uri))
    } else {
        parseTorrent.remote(uri, (err, parsed) => {
            if (err) {
                cb(false)
                return
            }
            toStream(parsed)
        })
    }
}

const {addonBuilder, getInterface, getRouter} = require('stremio-addon-sdk')

const builder = new addonBuilder({
    "id": "org.stremio.jackett",
    "version": "1.0.0",

    "name": "Jackett",
    "description": "Stremio Add-on to get torrent results from Jackett",

    "icon": "https://static1.squarespace.com/static/55c17e7ae4b08ccd27be814e/t/599b81c32994ca8ff6c1cd37/1508813048508/Jackett-logo-2.jpg",

    "resources": [
        "stream"
    ],

    "types": ["movie", "series"],

    "idPrefixes": ["tt"],

    "catalogs": []

})

builder.defineStreamHandler(args => {
    return new Promise((resolve, reject) => {

        if (!args.id) {
            reject(new Error('No ID Specified'))
            return
        }

        let results = []

        let sentResponse = false

        const respondStreams = () => {

            if (sentResponse) return
            sentResponse = true

            if (results && results.length) {

                tempResults = results

                // filter out torrents with less then 1 seed

                if (config.minimumSeeds)
                    tempResults = tempResults.filter(el => {
                        return !!(el.seeders && el.seeders > config.minimumSeeds - 1)
                    })

                // order by seeds desc

                tempResults = tempResults.sort((a, b) => {
                    return a.seeders < b.seeders ? 1 : -1
                })

                // limit to 15 results

                if (config.maximumResults)
                    tempResults = tempResults.slice(0, config.maximumResults)

                const streams = []

                const q = async.queue((task, callback) => {
                    if (task && (task.magneturl || task.link)) {
                        const url = task.magneturl || task.link
                        // jackett links can sometimes redirect to magnet links or torrent files
                        // we follow the redirect if needed and bring back the direct link
                        helper.followRedirect(url, url => {
                            // convert torrents and magnet links to stream object
                            streamFromMagnet(task, url, args.type, stream => {
                                if (stream)
                                    streams.push(stream)
                                callback()
                            })
                        })
                        return
                    }
                    callback()
                }, 1)

                q.drain = () => {
                    resolve({streams: streams})
                }

                tempResults.forEach(elm => {
                    q.push(elm)
                })
            } else {
                resolve({streams: []})
            }
        }

        const idParts = args.id.split(':')

        const imdb = idParts[0]

        cinemeta.get({type: args.type, imdb}).then(meta => {
            if (meta) {

                const searchQuery = {
                    name: meta.name,
                    year: meta.year,
                    type: args.type
                }

                if (idParts.length == 3) {
                    searchQuery.season = idParts[1]
                    searchQuery.episode = idParts[2]
                }

                jackettApi.search(searchQuery,

                    partialResponse = (tempResults) => {
                        results = results.concat(tempResults)
                    },

                    endResponse = (tempResults) => {
                        results = tempResults
                        respondStreams()
                    })


                if (config.respTimeout)
                    setTimeout(respondStreams, config.respTimeout)

            } else {
                resolve({streams: []})
            }
        })

    })
})

const addonInterface = getInterface(builder)

module.exports = getRouter(addonInterface)
