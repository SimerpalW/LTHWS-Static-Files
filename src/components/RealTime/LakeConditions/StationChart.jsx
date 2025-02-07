import { useState, useEffect } from "react";
import { useOutletContext } from "react-router-dom";

import ColorMarker from "../TahoeMap/ColorMarker";
import ErrorMarker from "../TahoeMap/ErrorMarker";
import "./LakeConditions.css"

import { colorScale, createLatLng, useIsMounted } from "../../../js/forked/util";
import { TercAPI } from "../../../js/forked/terc_api";
import { clamp } from "../../../js/forked/util";

import { Mutex } from "async-mutex"
import LoadingIcon from "../TahoeMap/LoadingIcon";
import IconMarker from "../TahoeMap/IconMarker";
import MaterialIconMarker from "../TahoeMap/MaterialIconMarker";
import { mean } from "d3";

function StationChart(props) {
    //////////////////////////////////////////////////////
    // Expected props
    // marker_data_type: the name of the data type that the markers on the map display
    // start_date: the start date of the chart
    // end_date: the end date of the chart
    // custom_marker_function: a function (station, station_idx, station_data_point, marker_props) => marker element on the map
    // children: a function with arguments (station_data, current_station) that returns the child to embed
    //      station_data is an Object { TmpStamp: Array(N), <Name of DataType>: Array(N) }
    const isMounted = useIsMounted();
    const [[map_markers, setMapMarkers, active_location_idx, setActiveLocation]] = useOutletContext();
    const [ current_station_data, setCurrentStationData ] = useState(undefined);
    const is_downloading = current_station_data === undefined;
    const is_unavailable = current_station_data === null;
    let { start_date, end_date, marker_data_type, custom_marker_function } = props;

    const STATIONS = TercAPI.get_stations_with_data_type(marker_data_type);

    ///////////////////////////////////////
    // Update current station data
    ///////////////////////////////////////
    const current_station = STATIONS[clamp(active_location_idx, 0, STATIONS.length - 1)];
    useEffect(() => {
        let ignore = false;

        // Set data to downloading state
        setCurrentStationData(undefined);
        if (ignore)
            return;
        
        current_station.get_data(start_date, end_date)
        .then((data) => {
            if (!ignore) {
                setCurrentStationData(data);
            }
        })
        .catch((err) => {
            console.log(err);
            if (!ignore) {
                setCurrentStationData(null);
            }
        });
        return () => { ignore = true; };
    }, [active_location_idx, start_date, end_date, marker_data_type]);

    ///////////////////////////////////////
    // Setup all stations
    ///////////////////////////////////////
    useEffect(() => {
        let ignore = false;

        // although station is not used in the component directly, its used in a hacky way in ModuleContainer
        // to get the tab description
        const loading_icons = STATIONS
            .map((station, idx) =>
                <LoadingIcon
                    key={`loading-station-${station.name}-${idx}`}
                    position={createLatLng(...station.coords)}
                    onClick={() => setActiveLocation(idx)}
                    active={idx === active_location_idx}
                    text={`Loading ${station.name}`}
                    station={station}
                    />
            )
        setMapMarkers(loading_icons);

        let lock = new Mutex();
        let most_recent_station_values = STATIONS.map(() => undefined);

        function process_station_data(station_idx, most_recent_station_data_point) {
            most_recent_station_values[station_idx] = most_recent_station_data_point;
            const marker_data_type_values = most_recent_station_values
                .map(x => x?.[marker_data_type])
                .map(x => Array.isArray(x) ? mean(x) : x)
            console.log(marker_data_type_values, most_recent_station_data_point)
            const valid_values = marker_data_type_values
                .filter(x => typeof x === "number");
            const min_value = Math.min(...valid_values);
            const max_value = Math.max(...valid_values);
            const min_color_rgb = [57, 140, 135];
            const max_color_rgb = [4, 52, 77];
            const color_scale = colorScale([min_color_rgb, max_color_rgb]);
            const get_color = (value) => {
                const color = (min_value === max_value) ? max_color_rgb :
                    color_scale((value - min_value) / (max_value - min_value));
                return `rgb(${color.join(",")})`;
            }
            
            const station_map_markers = 
                STATIONS
                .map((station, idx) => {
                    const on_click = () => { setActiveLocation(idx) };
                    const position = createLatLng(...station.coords);
                    const is_active = idx === active_location_idx;
                    const most_recent_data_point = most_recent_station_values[idx];
                    const most_recent_value = marker_data_type_values[idx]
                    const color = most_recent_value === undefined ? undefined : get_color(most_recent_value);
                    const marker_props = {
                        "position": position,
                        "onClick": on_click,
                        "active": is_active,
                        "text": station.name,
                        "color": color,
                        "station": station
                    }

                    if (most_recent_data_point === null) {
                        return <ErrorMarker
                                key={`station-marker-${station.name}-${idx}`}
                                error_msg={`${station.name} temporarily unavailable`}
                                {...marker_props}
                                />
                    }
                    else if (most_recent_data_point === undefined) {
                        marker_props.text = `Loading ${station.name}`;
                        return <LoadingIcon
                            key={`loading-station-${station.name}-${idx}`}
                            {...marker_props}
                            />
                    }
                    else if (station.map_icon !== undefined) {
                        return <MaterialIconMarker
                            key={`station-material-icon-${station.name}-${idx}`}
                            material_icon_name={`${station.map_icon}`}
                            {...marker_props}
                            />
                    }
                    else if (custom_marker_function !== undefined) {
                        marker_props.key = `custom-marker-icon-${station.name}-${idx}`; 
                        return custom_marker_function(station, most_recent_data_point, marker_props)
                    }

                    const marker_text = most_recent_value.toFixed(1);
                    return <ColorMarker
                        key={`station-marker-${station.name}-${idx}`}
                        {...marker_props}
                        text={marker_text}
                        />  
                });

            if (isMounted() && !ignore)
                setMapMarkers(station_map_markers);
        }

        // Download all station data           
        STATIONS
            .map((station, idx) => 
                station.get_most_recent_data(start_date, end_date)
                    .then(async (station_data_value) => {
                        return await lock.runExclusive(() => {
                            process_station_data(idx, station_data_value)
                        })
                    })
                    .catch(async (err) => {
                        console.log(`Failed to download valid data from station '${station.name}' ${err}}`)
                        return await lock.runExclusive(() => {
                            process_station_data(idx, null)
                        })
                    })
            )
        return () => { ignore = true; };
    }, [start_date.getTime(), end_date.getTime(), active_location_idx, marker_data_type, custom_marker_function]);

    return (
        <div className="lake-conditions-chart-container"> 
            {
                (is_downloading) ? 
                    <div> 
                        Downloading data
                    </div>
                : (is_unavailable) ?
                    <div>
                        Data at {current_station.name} is temporarily unavailable
                    </div>
                : 
                    <>
                    <div className="chart-title"> {current_station.name} </div>

                    { props.children(current_station_data, current_station) }

                    </>
            }
        </div>
    );
}

export default StationChart;