// Walibi Holland has it's own API separate from bellewaerde suddenly

import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

import moment from 'moment-timezone';
import * as cheerio from 'cheerio';

export class ParquesReunidos extends Destination {
  constructor(options = {}) {
    options.name = options.name || '';
    options.timezone = options.timezone || '';

    options.apiKey = options.apiKey || '';
    options.baseURL = options.baseURL || 'https://api-manager.stay-app.com';
    options.destinationSlug = options.destinationSlug || '';
    options.parkSlug = options.parkSlug || '';
    options.culture = options.culture || '';
    options.StayEstablishment = options.StayEstablishment || '';

    options.calendarURL = options.calendarURL || '';

    options.latitude = options.latitude || '';
    options.longitude = options.longitude || '';
    super(options);

    if (!this.config.apiKey) throw new Error('Missing ParquesReunidos API key');
    if (!this.config.baseURL) throw new Error('Missing ParquesReunidos baseURL');
    if (!this.config.StayEstablishment) throw new Error('Missing ParquesReunidos StayEstablishment');
    if (!this.config.calendarURL) throw new Error('Missing ParquesReunidos calendarURL');

    // setup some API hooks
    const baseURLHostname = new URL(this.config.baseURL).hostname;

    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // inject our API key into all requests to this domain
      options.headers = options.headers || {};
      options.headers['Authorization'] = 'Bearer ' + this.config.apiKey;
      options.headers['Stay-Establishment'] = this.config.StayEstablishment;
    });
  }

  /**
   * Fetch all POI data for this destination
   * @returns {object}
   */
  async fetchAttractionsPOI() {
    '@cache|1d'; // cache for 1 day
    const poi = await this.http('GET', `${this.config.baseURL}/api/v1/service/attraction`);
    return poi.body;
  }

  /**
   * Fetch all restaurant POI data for this destination
   * @returns {object}
   */
  async fetchRestaurantsPOI() {
    '@cache|1d'; // cache for 1 day
    const poi = await this.http('GET', `${this.config.baseURL}/api/v1/service/restaurant`);
    return poi.body;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    if (data) {
      if (data.translatableName?.[this.config.culture]) entity.name = data.translatableName?.[this.config.culture];
      if (data.place.point.longitude && data.place.point.latitude) {
        entity.location = {
          longitude: Number(data.place.point.longitude),
          latitude: Number(data.place.point.latitude),
        };
      }
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const doc = {};
    return {
      ...this.buildBaseEntityObject(doc),
      _id: this.config.destinationSlug,
      slug: this.config.destinationSlug,
      name: this.config.name,
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    return [
      {
        ...this.buildBaseEntityObject(null),
        _id: this.config.parkSlug,
        _destinationId: this.config.destinationSlug,
        _parentId: this.config.destinationSlug,
        name: this.config.name,
        entityType: entityType.park,
        location: {
          longitude: this.config.longitude,
          latitude: this.config.latitude
        }
      }
    ];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    // get POI data
    const poi = await this.fetchAttractionsPOI();

    // build entities
    return poi.map((x, idx) => {
      const entity = this.buildBaseEntityObject(x);
      return {
        ...entity,
        // use the array idx as our unique ID... not ideal but it's all we have
        _id: `attr_${x.id}`,
        _parkId: this.config.parkSlug,
        _parentId: this.config.parkSlug,
        _destinationId: this.config.destinationSlug,
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
      };
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return [];
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    // get POI data
    const poi = await this.fetchRestaurantsPOI();

    // build entities
    return poi.map((x, idx) => {
      const entity = this.buildBaseEntityObject(x);
      return {
        ...entity,
        _id: `dining_${x.id}`,
        _parkId: this.config.parkSlug,
        _parentId: this.config.parkSlug,
        _destinationId: this.config.destinationSlug,
        entityType: entityType.restaurant,
        name: x.translatableName?.[this.config.culture] || x.translatableName?.de || null
      };
    });
  }

  async fetchLiveData() {
    '@cache|1m'; // cache for 1 minute
    const resp = await this.http('GET', `${this.config.baseURL}/api/v1/service/attraction`);
    return resp.body;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const attractionData = await this.fetchAttractionsPOI();
    const waitData = await this.fetchLiveData();

    // this function should return all the live data for all entities in this destination
    return waitData.map((entry) => {
      // find matching attraction data
      const attraction = attractionData.find((x) => x.id === entry.id);
      if (!attraction) {
        return null;
      }

      const data = {
        _id: `attr_${attraction.id}`,
        status: statusType.operating,
      };

      switch (entry.temporaryClosed) {
        case 'true':
          data.status = statusType.down;
          break;
        case 'false':
          let waitTime = Number(entry.waitingTime || 0);
          if (waitTime > 0) {
            // set status
            data.status = statusType.operating;
          } else if (waitTime == -3){
            // set status
            // when I write this the park was closed and all attractions had waitTime set to -3
            data.status = statusType.closed;
          } else {

          }
          break;
        default:
          // unknown ride status - assume open but with no queue... ?
          data.status = statusType.operating;
          console.error('error', entry.id, `Unknown ride status ${entry.status} for ${entry.id}`, entry);
          debugger;
          break;
      }

      return data;
    }).filter((x) => !!x);
  }

  async fetchCalendarHTML() {
    '@cache|1d'; // cache voor 1 dag
    const resp = await this.http('GET', this.options.calendarURL);
    return resp.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const html = await this.fetchCalendarHTML();
    const $ = cheerio.load(html);
  
    const year = new Date().getFullYear(); // of dynamisch maken indien nodig
    const rawYearData = $(`#data-hour-${year}`).attr('value');
    const rawLabelsData = $('#data-hour-labels').attr('value');
  
    // Decode HTML entities
    const decode = (str) => {
      return str
        .replace(/&#34;/g, '"')
        .replace(/\\u0027/g, "'")
        .replace(/&quot;/g, '"');
    };
  
    const yearData = JSON.parse(decode(rawYearData)); // array per month with day->code mapping
    const labelMapRaw = JSON.parse(decode(rawLabelsData)); // array with {key: "time"} objects
    const labelMap = {};
  
    for (const entry of labelMapRaw) {
      const key = Object.keys(entry)[0];
      const val = entry[key];
      labelMap[key] = val;
    }
  
    const schedule = [];
  
    // Loop over the months
    for (let monthIndex = 0; monthIndex < yearData.length; monthIndex++) {
      const month = yearData[monthIndex];
      const monthNum = (monthIndex + 1).toString().padStart(2, '0');
  
      for (const dayStr in month) {
        const code = month[dayStr];
        if (!labelMap[code] || labelMap[code].toLowerCase().includes('closed')) {
          continue;
        }
  
        const label = labelMap[code];
        const [openingStr, closingStr] = label.split(' - ');
        if (!openingStr || !closingStr) continue;
  
        const date = `${year}-${monthNum}-${dayStr.padStart(2, '0')}`;
        const momentObj = moment.tz(date, this.config.timezone);
  
        const parseTime = (timeStr) => {
          const time = moment(timeStr, ['h:mma', 'ha']).toDate();
          return {
            hour: time.getHours(),
            minute: time.getMinutes()
          };
        };
  
        const opening = parseTime(openingStr);
        const closing = parseTime(closingStr);
  
        const openingTime = momentObj.clone().hour(opening.hour).minute(opening.minute).format();
        const closingTime = momentObj.clone().hour(closing.hour).minute(closing.minute).format();
  
        schedule.push({
          date,
          openingTime,
          closingTime,
          type: scheduleType.operating,
        });
      }
    }
  
    return [
      {
        _id: this.config.parkSlug,
        schedule,
      }
    ];
  }
}

export class MovieParkGermany extends ParquesReunidos {
  constructor(options = {}) {
    options.name = options.name || 'Movie Park Germany';
    options.calendarURL = options.calendarURL || 'https://www.movieparkgermany.de/en/oeffnungszeiten-und-preise/oeffnungszeiten';
    options.destinationSlug = options.destinationSlug || 'movieparkgermany';
    options.parkSlug = options.parkSlug || 'movieparkgermanypark';
    //options.apiShortcode = options.apiShortcode || 'blw';
    options.culture = options.culture || 'de';

    options.timezone = options.timezone || 'Europe/Berlin';

    options.latitude = 51.5973;
    options.longitude = 6.8647;

    options.StayEstablishment = options.StayEstablishment || "mBv6"; // mBv6

    super(options);
  }
}

export class Bobbejaanland extends ParquesReunidos {
  constructor(options = {}) {
    options.name = options.name || 'Bobbejaanland';
    options.calendarURL = options.calendarURL || 'https://www.bobbejaanland.be/openingsuren-en-prijzen/openingsuren';
    options.destinationSlug = options.destinationSlug || 'bobbejaanland';
    options.parkSlug = options.parkSlug || 'bobbejaanlandspark';
    //options.apiShortcode = options.apiShortcode || 'wra';
    options.culture = options.culture || 'nl';

    options.timezone = options.timezone || 'Europe/Brussels';

    options.latitude = 51.2021;
    options.longitude = 4.8828;

    options.StayEstablishment = options.StayEstablishment || "mGvE";

    super(options);
  }
}