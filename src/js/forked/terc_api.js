import { apply, celsius_to_f, format_ymd, http_get, range, renameProperty, today } from "./util";
import DATA_STATIONS from "../../static/data_stations.json";
import { Mutex } from "async-mutex"

class TimedCache {
    constructor(expiration_time) {
        this.expiration_time = expiration_time;
        this.cache = {};
    }

    put(key, value) {
        this.cache[key] = {
            "value": value, 
            "time": Date.now()
        };
    }

    has(key) {
        if (!(key in this.cache))
            return false;
        
        const now = Date.now();
        const expired = (now - this.cache[key].time) >= this.expiration_time;
        return !expired;
    }

    get(key) {
        return this.cache[key].value;
    }

    get length() {
        return Object.keys(this.cache).length;
    }
}

class UnitConverter {
    static conversion_ratios = {
        "c": {
            "f": celsius_to_f
        },
        "m": {
            "ft": (m) => m * 3.28084
        },
        "fnu": {
            "ntu": (fnu) => fnu
        },
        "m/s": {
            "mph": (m_s) => 2.2369 * m_s
        }
    }

    static convert(value, units, units_to_convert_to) {
        if (units === units_to_convert_to)
            return value;
        
        if (!(units in UnitConverter.conversion_ratios &&
            units_to_convert_to in UnitConverter.conversion_ratios[units]))
            throw new Error(`Conversion from '${units}' to '${units_to_convert_to}' is not implemented`)

        return UnitConverter.conversion_ratios[units][units_to_convert_to](value);
    }
}

class Station {
    static TIME_UNTIL_REDOWNLOAD = 60 * 60 * 1000; // one hour

    constructor(url, data_types, name, coords) {
        this.url = url;
        this.name = name;
        this.coords = coords;
        this.data_types = data_types;
        this.download_cache = new TimedCache(Station.TIME_UNTIL_REDOWNLOAD);
        this.mutex = new Mutex();
    }

    has_data_type(data_type_name) {
        const data_type_index = this.data_types
            .findIndex((dt) => dt.name === data_type_name)
        return data_type_index !== -1;
    }

    get_data_type(data_type_name) {
        return this.data_types.find((dt) => dt.name === data_type_name);
    }

    async fetch_data(params, key) {
        // Fetches the raw JSON data from the Station URL
        // Arguments:
        // params (optional): params to add onto the get request
        // key (optional): a key to hash the download
        return this.mutex.runExclusive(async () => {
            params = params ?? {};
    
            // Return data if already downloaded
            if (this.download_cache.has(key))
                return this.download_cache.get(key);
    
            const json = await http_get(this.url, params); 
            this.download_cache.put(key, json);
            return json;
        });
    }

    // abstract
    async get_data(start_date, end_date, data_type_name) {
        throw new Error("get_data is not implemented for this class!");
    }

    async get_most_recent_data(start_date, end_date, data_type_name) {
        let data = await this.get_data(start_date, end_date);
        let most_recent_data_point = data[data.length - 1];
        return most_recent_data_point[data_type_name]
    }
}

class DataStation extends Station {
    static TIME_KEY = "TmStamp";

    constructor(url, data_types, name, id, coords) {
        super(url, data_types, name, coords);
        this.id = id;
        this.get_data_mutex = new Mutex();
    }

    async download_data(start_date, end_date) {
        // Fetches the raw JSON data from the Station URL
        // Arguments:
        // start_date: a Date object, the start date of the data
        // end_date: a Date object, the end date of the data
        const start_date_str = format_ymd(start_date);
        const end_date_str = format_ymd(end_date);
        const key = `download_data-${start_date_str},${end_date_str}`;
        const params = {
            "id": this.id,
            "rptdate": start_date_str,
            "rptend": end_date_str
        };
        return await super.fetch_data(params, key);
    }

    parseTmStamp(date_string) {
        // Parses a date string in the format "YYYY-MM-DD HH:MM:SS"
        // Arguments:
        //  date_string: a String, in the format "YYYY-MM-DD HH:MM:SS"
    
        // date_string is pretty close to an ISO 8601 timestamp
        // timestamp specification see below
        // https://262.ecma-international.org/5.1/#sec-15.9.1.15
        // Convert date_string to ISO 8601 timestamp
        date_string = date_string.trim();
        date_string = date_string.replace(" ", "T");
        date_string += "Z";
    
        return new Date(date_string);
    }

    get_data_point_timestamp(data_point) {
        return this.parseTmStamp(data_point[DataStation.TIME_KEY]);
    }

    async get_data(start_date, end_date) {
        // Normalizes data from the Terc API into a format used by all charts
        // Arguments:
        // start_date: Date object, the start time of the data
        // end_date: Date object, the end time of the data
        // returns: An Array of N objects containing data in the following format
        //    Timestamp: a Date Object, 
        //    <a data_type_name 0>: a Float
        //    <a data_type_name 1>: a Float
        //    where data_type_name is a static member of TercAPI
        return this.get_data_mutex.runExclusive(async () => {
            // Return data if already processed
            const key = `get_data-${format_ymd(start_date)},${format_ymd(end_date)}`;
            if (this.download_cache.has(key)) {
                return this.download_cache.get(key);
            }

            const raw_data = await this.download_data(start_date, end_date);
            raw_data.forEach((data_point) => {
                this.data_types.forEach(({name: data_type_name, key: data_type_key, name_units, key_units}) => {
                    let data_type_value = parseFloat(data_point[data_type_key]);
                    // stations can contain data points with 'None' as the value, where parseFloat will fail
                    if (isNaN(data_type_value)) {
                        data_type_value = 0; 
                    }
                    data_type_value = UnitConverter.convert(data_type_value, key_units, name_units)
                    // assign parsed value to standard data type name
                    data_point[data_type_name] = data_type_value;
                    delete data_point[data_type_key]; // delete old key
                })
                data_point[TercAPI.TIME_NAME] = this.get_data_point_timestamp(data_point);
                delete data_point[DataStation.TIME_KEY];
            })
            
            raw_data.sort((a, b) => {
                if (a[TercAPI.TIME_NAME] < b[TercAPI.TIME_NAME]) return -1;
                else if (a[TercAPI.TIME_NAME] > b[TercAPI.TIME_NAME]) return 1;
                return 0;
            });

            if (raw_data.length <= 2) {
                this.download_cache.put(key, null);
                throw new Error(`Station '${this.name}' doesn't contain enough data points (${raw_data.length} data points)`);
            }

            this.download_cache.put(key, raw_data);
            return raw_data;
        });
    
    }
}

class SotlStation extends DataStation {

    constructor(url, data_types, name, coords) {
        super(url, data_types, name, undefined, coords);
    }

    async download_data(start_date, end_date) {
        const start_date_year = start_date.getUTCFullYear();
        const end_date_year = end_date.getUTCFullYear();
        const dates = range(start_date_year, end_date_year + 1);
        const result = await Promise.all(
            dates.map((year) => this.download_data_for_year(year))
        );
        return result;
    }

    async download_data_for_year(year) {
        // Fetches the raw JSON data from the Station URL
        // Arguments:
        // year: a Number or String representing the calendar year of the data
        const key = `download_data-${year}`;
        const params = {
            "id": year,
        };
        const res = await super.fetch_data(params, key);
        return res[0];
    }

    get_data_point_timestamp(data_point) {
        return new Date(`${data_point["Year"]}-01-01`);
    }

}

////////////////////////////////////////////////////////////////
// Initialize Stations
////////////////////////////////////////////////////////////////

const STATIONS = Object.values(DATA_STATIONS)
    .flatMap(({URL, DATA_TYPES, STATIONS, STATION_TYPE}) => {
        return STATIONS
        .filter(({inactive}) => inactive !== true)
        .map(({name, id, coords, DATA_TYPE_OVERRIDES}) => {
            let data_types = JSON.parse(JSON.stringify(DATA_TYPES));
            if (DATA_TYPE_OVERRIDES) 
                DATA_TYPE_OVERRIDES.forEach((data_type_override) => {
                    let override_index = data_types.findIndex((station_data_type) => station_data_type.name == data_type_override.name)
                    if (override_index === -1)
                        throw new Error(`Unexpected could not find override ${data_type_override}`)
                    data_types[override_index] = data_type_override;
                });

            switch (STATION_TYPE) {
                case "Sotl":
                    return new SotlStation(URL, data_types, name, coords);
                case "Data":
                case undefined:
                    return new DataStation(URL, data_types, name, id, coords);
                default:
                    throw new Error(`Unknown station type '${STATION_TYPE}'`)
            }
            });
    });

class TercAPI {
    static STATIONS = STATIONS;

    // Data type names
    static TIME_NAME                    = "Timestamp"
    static WAVE_HEIGHT_NAME             = "Wave Height";
    static WATER_TEMPERATURE_NAME       = "Water Temperature";
    static WIND_SPEED_NAME              = "Wind Speed";
    static WIND_DIRECTION_NAME          = "Wind Direction";
    static AIR_TEMPERATURE_NAME         = "Air Temperature";
    static CONDUCTIVITY_NAME            = "Conductivity";
    static ALGAE_NAME                   = "Algae";
    static TURBIDITY_NAME               = "Turbidity";
    static LAKE_LEVEL_NAME              = "Lake Level";
    static RIVER_DISCHARGE_NAME         = "Discharge";
    static SECCHI_DEPTH_NAME            = "Secchi Depth";
    static MONTHLY_MAX_TEMPERATURE_NAME = "Monthly Max Temperature";
    static MONTHLY_MIN_TEMPERATURE_NAME = "Monthly Min Temperature";
    static MONTHLY_PRECIPITATION_NAME   = "Monthly Precipitation";

    static get_stations_with_data_type(data_type_name) {
        return STATIONS
            .filter((station) => station.has_data_type(data_type_name));
    }

    static get_stations_with_data_types(data_type_names) {
        return STATIONS
            .filter((station) => data_type_names.every((dt) => station.has_data_type(dt)))
    }
}

export { TercAPI };