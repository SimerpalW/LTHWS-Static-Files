import { useEffect, useRef } from "react";
import { draw_lake_heatmap, round } from "../util";
import { select, pointer } from "d3";

function TemperatureMap(props) {
    const canvas_ref = useRef();
    const T = props.T;

    ////////////////////////////////////
    // Dimensions
    ////////////////////////////////////
    const [n_rows, n_cols] = [props.T.length, props.T[0].length];
    const aspect_ratio = n_cols / n_rows;

    ////////////////////////////////////
    // Draw Heatmap
    ////////////////////////////////////
    useEffect(() => {
        const canvas = canvas_ref.current;
        const color_palette = props.color_palette;

        // Resize canvas
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.width / aspect_ratio;

        let start_time = Date.now();
        let cache_key = `temperature-${props.activeIdx}`;
        draw_lake_heatmap(canvas, T, color_palette, cache_key);
        let end_time = Date.now();

        console.log(`Took ${end_time - start_time} ms to draw image`);
    }, [props.T, props.color_palette]);

    ////////////////////////////////////
    // Cursor Hover Event
    ////////////////////////////////////
    useEffect(() => {
        const canvas = canvas_ref.current;

        select(canvas).on("mousemove", function (event) {
            const [x, y] = pointer(event);
            const [i, j] = [Math.floor(x / canvas.width * n_cols), Math.floor(y / canvas.height * n_rows)];
            if (i < 0 || i >= n_cols || j < 0 || j >= n_rows || isNaN(T[j][i])) {
                select(".temperature-cursor")
                    .style("display", "none");
                return;
            }
            
            const [px, py] = [x / canvas.width * 100, y / canvas.height * 100];
            const temp = round(T[j][i]);
            select(".temperature-cursor")
                .style("display", "block")
                .style("left", `${px}%`)
                .style("top", `${py}%`)
                .text(`${temp} °F`);
        });
        select(canvas).on("mouseleave", () => {
            select(".temperature-cursor")
                .style("display", "none");
        });
    }, [n_cols, n_rows, T]);
    
    return (
        <div className="temperature-chart-container">
            <canvas ref={canvas_ref}></canvas>
            <div className="temperature-cursor"> Cursor </div>
        </div>
    );
}

export default TemperatureMap;